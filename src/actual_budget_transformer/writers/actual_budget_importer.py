"""Direct import to a self-hosted Actual Budget server.

Implements the conservative-automation principles in
``docs/archive/adr-002-conservative-automation-principles.md`` on top of the
JSON-over-stdio bridge in ``actual_api.py``: monthly + checkpoint batching
(ADR-005), three-bucket classification with `imported_id` exact-match dedup
(ADR-006), per-account circuit breaker, inline balance verification.

Public surface: ``ActualBudgetImporter`` (context-managed) with
``import_transactions(result, balance_checkpoints=None)``. Pure helpers below
are exported for unit tests.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from actual_budget_transformer.actual_api import ActualBridge
from actual_budget_transformer.config import load_config
from actual_budget_transformer.logging_config import logger
from actual_budget_transformer.processors.base_processor import ProcessingResult

# ---------------------------------------------------------------------------
# Pure data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BalanceCheckpoint:
    """Statement balance at a date, in account currency (e.g. CHF).

    ``amount`` is signed: positive = credit-side balance.
    """

    date: dt.date
    amount: float


@dataclass(frozen=True)
class Batch:
    """One processing window: everything up to and including ``boundary``."""

    boundary: dt.date
    checkpoint: BalanceCheckpoint | None = None


@dataclass
class BatchOutcome:
    clean_imported: int = 0
    suspicious_imported: int = 0
    skipped: int = 0
    aborted: bool = False
    abort_reason: str = ""


@dataclass
class _AccountState:
    reconciliation_date: dt.date | None = None
    stopped: bool = False
    stop_reason: str = ""
    outcomes: list[BatchOutcome] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Pure helpers (testable offline)
# ---------------------------------------------------------------------------


def _stable_id(date: str, amount: int, payee: str, notes: str) -> str:
    """Deterministic imported_id for source rows that lack a bank reference."""
    h = hashlib.sha1(f"{date}|{amount}|{payee}|{notes}".encode())
    return f"abt-{h.hexdigest()[:16]}"


def _coerce_amount_cents(debit: Any, credit: Any) -> int:
    """Convert (debit, credit) pair from a processor row to integer cents.

    Debits are negative, credits are positive — Actual's convention.
    """
    d = 0.0 if debit is None or pd.isna(debit) else float(debit)
    c = 0.0 if credit is None or pd.isna(credit) else float(credit)
    return int(round((c - d) * 100))


def df_to_actual_txs(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert a ``ProcessingResult.data`` slice into Actual import rows.

    The returned dicts are passed directly to the bridge's
    ``import_transactions`` (which injects ``account`` server-side). Every row
    is given a stable ``imported_id`` so re-runs are idempotent (ADR-006).
    """
    rows: list[dict[str, Any]] = []
    for _, r in df.iterrows():
        amount = _coerce_amount_cents(r.get("debit"), r.get("credit"))
        date = pd.Timestamp(r["transaction_date"]).date().isoformat()
        payee = "" if pd.isna(r.get("payee")) else str(r.get("payee") or "")
        notes = "" if pd.isna(r.get("notes")) else str(r.get("notes") or "")
        ref = "" if pd.isna(r.get("reference")) else str(r.get("reference") or "")
        imported_id = ref or _stable_id(date, amount, payee, notes)
        rows.append(
            {
                "date": date,
                "amount": amount,
                "imported_id": imported_id,
                "payee_name": payee,
                "notes": notes,
            }
        )
    return rows


def _last_day_of_month(d: dt.date) -> dt.date:
    if d.month == 12:
        first_next = dt.date(d.year + 1, 1, 1)
    else:
        first_next = dt.date(d.year, d.month + 1, 1)
    return first_next - dt.timedelta(days=1)


def compute_batches(
    tx_dates: list[dt.date],
    checkpoints: list[BalanceCheckpoint],
) -> list[Batch]:
    """Return the ordered list of batch boundaries.

    Boundaries are the union of:
      * last day of each month touched by ``tx_dates``;
      * each checkpoint date.
    A checkpoint that falls on a month-end deduplicates onto the same
    boundary and contributes its balance for inline verification (ADR-005).
    """
    if not tx_dates:
        return []
    boundaries: dict[dt.date, BalanceCheckpoint | None] = {}
    for d in tx_dates:
        boundaries.setdefault(_last_day_of_month(d), None)
    for cp in checkpoints:
        boundaries[cp.date] = cp
    return [Batch(boundary=b, checkpoint=boundaries[b]) for b in sorted(boundaries)]


def classify_transactions(
    source_txs: list[dict[str, Any]],
    existing_txs: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Three-bucket split per ADR-006.

    Returns ``(clean, suspicious, skipped)``.

    * ``skipped``: source has ``imported_id`` already present in ``existing_txs``.
    * ``suspicious``: any existing tx with the same amount and date within
      ±1 day of the source — flagged for human review.
    * ``clean``: everything else.
    """
    existing_ids = {t["imported_id"] for t in existing_txs if t.get("imported_id")}

    by_amount: dict[int, list[dt.date]] = defaultdict(list)
    for t in existing_txs:
        if t.get("date") and t.get("amount") is not None:
            try:
                by_amount[int(t["amount"])].append(dt.date.fromisoformat(t["date"]))
            except TypeError, ValueError:
                continue

    clean: list[dict[str, Any]] = []
    suspicious: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for tx in source_txs:
        if tx.get("imported_id") in existing_ids:
            skipped.append(tx)
            continue
        tx_date = dt.date.fromisoformat(tx["date"])
        candidates = by_amount.get(int(tx["amount"]), ())
        match = any(abs((c - tx_date).days) <= 1 for c in candidates)
        (suspicious if match else clean).append(tx)
    return clean, suspicious, skipped


def circuit_breaker_trips(suspicious_count: int, threshold: int) -> bool:
    """ADR-002: stop early when the suspicious count exceeds the threshold."""
    return suspicious_count > threshold


def resolve_actual_config(
    config: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Merge the ``actual_budget`` YAML block with env-var overrides.

    Env wins: ``ACTUAL_BUDGET_URL`` / ``_PASSWORD`` / ``_FILE`` for the three
    sensitive values. ``data_dir`` defaults to a fresh temp dir.
    """
    if config is None:
        config = load_config()
    if env is None:
        env = os.environ  # type: ignore[assignment]
    block = config.get("actual_budget", {}) or {}

    server_url = env.get("ACTUAL_BUDGET_URL") or block.get("server_url")
    password = env.get("ACTUAL_BUDGET_PASSWORD") or block.get("password")
    budget_name = env.get("ACTUAL_BUDGET_FILE") or block.get("budget_name")

    missing = [
        name
        for name, val in [
            ("server_url", server_url),
            ("password", password),
            ("budget_name", budget_name),
        ]
        if not val
    ]
    if missing:
        raise ValueError(
            "actual_budget config incomplete; missing "
            f"{', '.join(missing)} (set under actual_budget: in YAML or via "
            "ACTUAL_BUDGET_URL / ACTUAL_BUDGET_PASSWORD / ACTUAL_BUDGET_FILE)"
        )

    return {
        "server_url": server_url,
        "password": password,
        "budget_name": budget_name,
        "data_dir": block.get("data_dir"),
        "review_category": block.get("review_category", "To Review"),
        "suspicious_threshold": int(block.get("suspicious_threshold", 5)),
    }


# ---------------------------------------------------------------------------
# Importer (orchestrator)
# ---------------------------------------------------------------------------


class ActualBudgetImporter:
    """Direct-import wrapper around an ``ActualBridge``.

    Lifecycle: open as a context manager once per CLI invocation; reuse for
    every processed file (each file is one account's monthly statement).
    """

    def __init__(
        self,
        *,
        server_url: str,
        password: str,
        budget_name: str,
        data_dir: str | None = None,
        review_category: str = "To Review",
        suspicious_threshold: int = 5,
    ) -> None:
        self._server_url = server_url
        self._password = password
        self._budget_name = budget_name
        self._data_dir = data_dir
        self._review_category = review_category
        self._suspicious_threshold = suspicious_threshold

        self._bridge: ActualBridge | None = None
        self._owns_data_dir = False
        self._accounts_cache: list[dict[str, Any]] | None = None
        self._review_category_id: str | None = None
        self._account_state: dict[str, _AccountState] = {}

    @classmethod
    def from_config(cls) -> ActualBudgetImporter:
        """Build from the cached YAML config + env vars."""
        return cls(**resolve_actual_config())

    def __enter__(self) -> ActualBudgetImporter:
        if self._data_dir is None:
            self._data_dir = tempfile.mkdtemp(prefix="actual-import-")
            self._owns_data_dir = True
        self._bridge = ActualBridge(
            server_url=self._server_url,
            password=self._password,
            data_dir=self._data_dir,
            budget_name=self._budget_name,
        ).__enter__()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._bridge:
            self._bridge.__exit__(exc_type, exc, tb)
            self._bridge = None
        if self._owns_data_dir and self._data_dir and os.path.isdir(self._data_dir):
            import shutil

            shutil.rmtree(self._data_dir, ignore_errors=True)

    # -- main entry point ---------------------------------------------------

    def import_transactions(
        self,
        result: ProcessingResult,
        balance_checkpoints: list[BalanceCheckpoint] | None = None,
    ) -> None:
        bridge = self._require_bridge()
        df = result.data
        account_name = result.output_prefix

        account = self._find_account(account_name)
        account_id = account["id"]

        state = self._account_state.setdefault(account_name, _AccountState())
        if state.stopped:
            logger.warning(
                "Skipping %s: account previously stopped this run (%s)",
                account_name,
                state.stop_reason,
            )
            return

        if df.empty:
            logger.info(
                "%s: no transactions in source — nothing to import", account_name
            )
            return

        txs = df_to_actual_txs(df)

        rec_date = self._reconciliation_date(account_id, state)
        if rec_date is not None:
            before = len(txs)
            txs = [t for t in txs if dt.date.fromisoformat(t["date"]) > rec_date]
            removed = before - len(txs)
            if removed:
                logger.info(
                    "%s: filtered %d tx on/before reconciled %s",
                    account_name,
                    removed,
                    rec_date,
                )
        if not txs:
            logger.info(
                "%s: nothing to import after reconciliation filter", account_name
            )
            return

        tx_dates = [dt.date.fromisoformat(t["date"]) for t in txs]
        batches = compute_batches(tx_dates, balance_checkpoints or [])

        prev_boundary: dt.date | None = None
        for batch in batches:
            batch_start = (
                prev_boundary + dt.timedelta(days=1) if prev_boundary else min(tx_dates)
            )
            batch_end = batch.boundary
            prev_boundary = batch_end

            batch_txs = [
                t
                for t in txs
                if batch_start <= dt.date.fromisoformat(t["date"]) <= batch_end
            ]
            if not batch_txs:
                continue

            outcome = self._run_batch(
                bridge=bridge,
                account_id=account_id,
                account_name=account_name,
                batch=batch,
                batch_start=batch_start,
                batch_txs=batch_txs,
            )
            state.outcomes.append(outcome)
            if outcome.aborted:
                state.stopped = True
                state.stop_reason = outcome.abort_reason
                return

        logger.info(
            "%s: import complete (%d batch(es))", account_name, len(state.outcomes)
        )

    # -- internals ---------------------------------------------------------

    def _run_batch(
        self,
        *,
        bridge: ActualBridge,
        account_id: str,
        account_name: str,
        batch: Batch,
        batch_start: dt.date,
        batch_txs: list[dict[str, Any]],
    ) -> BatchOutcome:
        existing = bridge.get_transactions(
            account_id,
            (batch_start - dt.timedelta(days=1)).isoformat(),
            (batch.boundary + dt.timedelta(days=1)).isoformat(),
        )
        clean, suspicious, skipped = classify_transactions(batch_txs, existing)
        logger.info(
            "%s [%s..%s]: %d clean, %d suspicious, %d already-imported",
            account_name,
            batch_start,
            batch.boundary,
            len(clean),
            len(suspicious),
            len(skipped),
        )

        if circuit_breaker_trips(len(suspicious), self._suspicious_threshold):
            threshold = self._suspicious_threshold
            reason = (
                f"suspicious={len(suspicious)} > threshold={threshold} "
                f"in batch ending {batch.boundary}"
            )
            logger.error(
                "%s: circuit breaker tripped — %s. Aborting account.",
                account_name,
                reason,
            )
            return BatchOutcome(skipped=len(skipped), aborted=True, abort_reason=reason)

        if clean:
            res = bridge.import_transactions(account_id, clean)
            errs = res.get("errors") or []
            if errs:
                logger.error(
                    "%s: import_transactions errors on clean: %s",
                    account_name,
                    errs,
                )
            logger.info(
                "%s: imported %d clean (added=%s)",
                account_name,
                len(clean),
                len(res.get("added") or []),
            )

        if suspicious:
            review_cat_id = self._resolve_review_category()
            for t in suspicious:
                t["category"] = review_cat_id
            res = bridge.import_transactions(account_id, suspicious)
            errs = res.get("errors") or []
            if errs:
                logger.error(
                    "%s: import_transactions errors on suspicious: %s",
                    account_name,
                    errs,
                )
            logger.info(
                "%s: imported %d suspicious (review category=%r)",
                account_name,
                len(suspicious),
                self._review_category,
            )

        # Persist the batch's writes so balance verification + crash recovery
        # see consistent state on the server.
        bridge.sync()

        if batch.checkpoint is not None:
            actual_cents = bridge.get_account_balance(
                account_id, batch.boundary.isoformat()
            )
            expected_cents = int(round(batch.checkpoint.amount * 100))
            if actual_cents != expected_cents:
                reason = (
                    f"balance mismatch at {batch.boundary}: "
                    f"actual={actual_cents}, expected={expected_cents}"
                )
                logger.error("%s: %s. Aborting account.", account_name, reason)
                return BatchOutcome(
                    clean_imported=len(clean),
                    suspicious_imported=len(suspicious),
                    skipped=len(skipped),
                    aborted=True,
                    abort_reason=reason,
                )
            logger.info(
                "%s: balance verified at %s (%d cents)",
                account_name,
                batch.boundary,
                actual_cents,
            )

        return BatchOutcome(
            clean_imported=len(clean),
            suspicious_imported=len(suspicious),
            skipped=len(skipped),
        )

    def _require_bridge(self) -> ActualBridge:
        if self._bridge is None:
            raise RuntimeError(
                "ActualBudgetImporter must be used as a context manager "
                "(`with ActualBudgetImporter(...) as imp:`)"
            )
        return self._bridge

    def _find_account(self, name: str) -> dict[str, Any]:
        if self._accounts_cache is None:
            self._accounts_cache = self._require_bridge().get_accounts()
        for a in self._accounts_cache:
            if a.get("name") == name and not a.get("closed"):
                return a
        available = [
            a.get("name", "(unnamed)")
            for a in self._accounts_cache
            if not a.get("closed")
        ]
        raise ValueError(
            f"Account {name!r} not found in budget. Available: {sorted(available)}"
        )

    def _resolve_review_category(self) -> str:
        if self._review_category_id is not None:
            return self._review_category_id
        cats = self._require_bridge().get_categories()
        matches = [c for c in cats if c.get("name") == self._review_category]
        if not matches:
            available = sorted({c.get("name", "(unnamed)") for c in cats})
            raise ValueError(
                f"Review category {self._review_category!r} not found. "
                f"Available: {available}"
            )
        if len(matches) > 1:
            raise ValueError(
                f"Review category {self._review_category!r} is ambiguous "
                f"({len(matches)} matches). Rename one to disambiguate."
            )
        self._review_category_id = matches[0]["id"]
        return self._review_category_id

    def _reconciliation_date(
        self, account_id: str, state: _AccountState
    ) -> dt.date | None:
        if state.reconciliation_date is not None:
            return state.reconciliation_date
        # Wide query — Actual has no API for "last reconciled date" so we read
        # the account history and take the max reconciled tx date.
        today = dt.date.today().isoformat()
        txs = self._require_bridge().get_transactions(account_id, "1900-01-01", today)
        dates = [
            dt.date.fromisoformat(t["date"])
            for t in txs
            if t.get("reconciled") and t.get("date")
        ]
        if dates:
            state.reconciliation_date = max(dates)
        return state.reconciliation_date
