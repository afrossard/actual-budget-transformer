"""End-to-end integration tests for ``ActualBudgetImporter`` against the live
test server.

Each test scopes assertions to a unique ``imported_id`` prefix (``run_tag``)
so re-runs accumulate harmlessly. Pre-seeded transactions and successfully
imported transactions stay in the test budget between runs; if you want a
clean slate run ``actual-down && actual-up && npm run bootstrap`` (the
container's tmpfs gets wiped on down).

Date convention: regular tests use dates ``>= 2030``. Deep-past dates (2020)
are reserved for reconciliation-boundary tests — the reconciliation boundary
is account-global persistent server state that cannot be ``run_tag``-scoped,
so it must sit *below* every other test's date range. See
``test_reconciled_boundary_filters_on_or_before``.

Preconditions:
  * `actual-up` (server reachable at ACTUAL_SERVER_URL)
  * `npm run bootstrap` (creates the budget, the three test accounts, and the
    "To Review" category required by the suspicious-bucket test)
"""

from __future__ import annotations

import datetime as dt
import os
import random
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator

import pandas as pd
import pytest

from actual_budget_transformer.actual_api import ActualBridge
from actual_budget_transformer.processors.base_processor import ProcessingResult
from actual_budget_transformer.writers.actual_budget_importer import (
    ActualBudgetImporter,
    BalanceCheckpoint,
)

SERVER_URL = os.environ.get("ACTUAL_SERVER_URL", "http://actual-server:5006")
PASSWORD = os.environ.get("ACTUAL_PASSWORD", "test-password")
BUDGET_NAME = os.environ.get("ACTUAL_BUDGET_NAME", "Test Budget")
REVIEW_CATEGORY = "To Review"


def _server_reachable() -> bool:
    try:
        urllib.request.urlopen(f"{SERVER_URL}/account/needs-bootstrap", timeout=2)
        return True
    except urllib.error.URLError, OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _server_reachable(),
    reason=(
        f"Actual server unreachable at {SERVER_URL}; "
        "start with `actual-up` and run `npm run bootstrap`"
    ),
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_importer(
    *,
    suspicious_threshold: int = 5,
    review_category: str = REVIEW_CATEGORY,
) -> ActualBudgetImporter:
    return ActualBudgetImporter(
        server_url=SERVER_URL,
        password=PASSWORD,
        budget_name=BUDGET_NAME,
        review_category=review_category,
        suspicious_threshold=suspicious_threshold,
    )


@pytest.fixture
def importer() -> Iterator[ActualBudgetImporter]:
    with _make_importer() as imp:
        yield imp


@pytest.fixture(scope="module")
def assert_bridge() -> Iterator[ActualBridge]:
    """Independent bridge for tests to query/seed state without going through
    the importer's bridge — keeps the importer's lifecycle clean."""
    data_dir = tempfile.mkdtemp(prefix="actual-int-assert-")
    with ActualBridge(
        server_url=SERVER_URL,
        password=PASSWORD,
        data_dir=data_dir,
        budget_name=BUDGET_NAME,
    ) as b:
        yield b


@pytest.fixture(scope="module")
def account_ids(assert_bridge: ActualBridge) -> dict[str, str]:
    by_name = {a.get("name"): a["id"] for a in assert_bridge.get_accounts()}
    needed = ("Test Checking", "Test Savings", "Test Credit Card")
    missing = [n for n in needed if n not in by_name]
    if missing:
        pytest.fail(
            f"Account(s) {missing} not found on server — re-run `npm run bootstrap`"
        )
    return {n: by_name[n] for n in needed}


@pytest.fixture(scope="module")
def review_category_id(assert_bridge: ActualBridge) -> str:
    cats = assert_bridge.get_categories()
    matches = [c for c in cats if c.get("name") == REVIEW_CATEGORY]
    if not matches:
        pytest.skip(
            f"Review category {REVIEW_CATEGORY!r} not found — re-run "
            "`npm run bootstrap` (category was added in the importer landing)"
        )
    return matches[0]["id"]


@pytest.fixture
def run_tag() -> str:
    return f"int-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_tx(bridge: ActualBridge, account_id: str, txs: list[dict]) -> None:
    """Pre-seed transactions and push them to the server so the next bridge
    that opens the budget will see them."""
    bridge.import_transactions(account_id, txs)
    bridge.sync()


def _fetch_tx(
    bridge: ActualBridge, account_id: str, start: str, end: str
) -> list[dict]:
    """Pull any remote changes into the local cache before reading.

    Each ``ActualBridge`` keeps its own SQLite cache; without this sync the
    fetcher won't see writes performed by another bridge (e.g. the importer
    under test). ``importTransactions`` itself doesn't push, so seeded data
    needs ``sync()`` too — see ``_seed_tx``."""
    bridge.sync()
    return bridge.get_transactions(account_id, start, end)


def _fetch_balance(
    bridge: ActualBridge, account_id: str, cutoff: str | None = None
) -> int:
    bridge.sync()
    return bridge.get_account_balance(account_id, cutoff)


def _df(rows: list[dict]) -> pd.DataFrame:
    """Build a processor-shaped DataFrame from convenience dicts."""
    return pd.DataFrame(
        [
            {
                "transaction_date": pd.Timestamp(r["date"]),
                "payee": r.get("payee", ""),
                "notes": r.get("notes", ""),
                "debit": r.get("debit", float("nan")),
                "credit": r.get("credit", float("nan")),
                "reference": r.get("reference", ""),
            }
            for r in rows
        ]
    )


def _result(rows: list[dict], output_prefix: str) -> ProcessingResult:
    return ProcessingResult(data=_df(rows), output_prefix=output_prefix)


def _scoped(txs: list[dict], tag: str) -> list[dict]:
    return [t for t in txs if (t.get("imported_id") or "").startswith(tag)]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_smoke_clean_import_round_trip(
    importer: ActualBudgetImporter,
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    run_tag: str,
) -> None:
    """A typical month of fresh transactions imports cleanly: amounts and
    dates round-trip via the bridge, ``imported_id`` is the source reference."""
    account_id = account_ids["Test Checking"]
    rows = [
        {
            "date": "2030-01-05",
            "payee": "A",
            "debit": 10.00,
            "reference": f"{run_tag}-1",
        },
        {
            "date": "2030-01-15",
            "payee": "B",
            "credit": 50.00,
            "reference": f"{run_tag}-2",
        },
        {
            "date": "2030-01-20",
            "payee": "C",
            "debit": 5.00,
            "reference": f"{run_tag}-3",
        },
    ]
    importer.import_transactions(_result(rows, "Test Checking"))

    fetched = _fetch_tx(assert_bridge, account_id, "2030-01-01", "2030-01-31")
    mine = {t["imported_id"]: t for t in _scoped(fetched, run_tag)}
    assert set(mine) == {f"{run_tag}-{i}" for i in (1, 2, 3)}
    assert mine[f"{run_tag}-1"]["amount"] == -1000
    assert mine[f"{run_tag}-2"]["amount"] == 5000
    assert mine[f"{run_tag}-3"]["amount"] == -500


def test_rerun_is_idempotent(
    importer: ActualBudgetImporter,
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    run_tag: str,
) -> None:
    """Running the same import twice must not duplicate transactions — the
    second run sees the imported_id already present and skips."""
    account_id = account_ids["Test Checking"]
    rows = [
        {
            "date": "2030-02-10",
            "payee": "Repeat",
            "debit": 7.50,
            "reference": f"{run_tag}-1",
        }
    ]
    result = _result(rows, "Test Checking")
    importer.import_transactions(result)
    importer.import_transactions(result)

    fetched = _fetch_tx(assert_bridge, account_id, "2030-02-01", "2030-02-28")
    mine = _scoped(fetched, run_tag)
    assert len(mine) == 1, f"expected idempotent re-run, found {len(mine)}"
    assert mine[0]["amount"] == -750


def test_reconciled_boundary_filters_on_or_before(
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    run_tag: str,
) -> None:
    """The "skip reconciled" keystone, proven end-to-end (ADR-002).

    A reconciled transaction defines the account's reconciliation boundary;
    source transactions on/before it are filtered out, later ones import.

    Deep-past date convention: the reconciliation boundary is account-global
    persistent server state and *cannot* be ``run_tag``-scoped, so this test
    uses 2020 dates that sit below every other test's range (regular tests use
    ``>= 2030``). Each re-run leaves another reconciled 2020-06-30 tx behind,
    but they all share that date so the boundary never moves.
    """
    account_id = account_ids["Test Savings"]
    seed_id = f"recon-seed-{run_tag}"
    before_id = f"recon-before-{run_tag}"
    after_id = f"recon-after-{run_tag}"

    # Per-run-unique amount so the post-boundary tx classifies clean on every
    # re-run (a fixed amount would look suspicious against earlier runs' import
    # at the same date, dragging in the review-category dependency).
    after_debit = (1000 + int(run_tag.split("-")[1]) % 90000) / 100.0

    # Seed a transaction at the boundary date and mark it reconciled via the
    # new bridge command (no UI dance).
    _seed_tx(
        assert_bridge,
        account_id,
        [
            {
                "date": "2020-06-30",
                "amount": -5000,
                "imported_id": seed_id,
                "payee_name": "Reconciled boundary seed",
            }
        ],
    )
    seeded = _fetch_tx(assert_bridge, account_id, "2020-06-30", "2020-06-30")
    seed_tx = next(t for t in seeded if t.get("imported_id") == seed_id)
    assert_bridge.update_transaction(seed_tx["id"], {"reconciled": True})
    assert_bridge.sync()

    # Assertion A: getTransactions surfaces `reconciled` truthy at runtime —
    # the boundary computation rests on a real field, not an assumption.
    reread = _fetch_tx(assert_bridge, account_id, "2020-06-30", "2020-06-30")
    seed_after = next(t for t in reread if t.get("imported_id") == seed_id)
    assert seed_after.get("reconciled"), (
        "getTransactions must surface `reconciled` as truthy "
        f"(got {seed_after.get('reconciled')!r})"
    )

    # Import two source tx straddling the boundary in one run.
    with _make_importer() as imp:
        imp.import_transactions(
            _result(
                [
                    {
                        "date": "2020-06-15",
                        "payee": "Before boundary",
                        "debit": 12.50,
                        "reference": before_id,
                    },
                    {
                        "date": "2020-07-15",
                        "payee": "After boundary",
                        "debit": after_debit,
                        "reference": after_id,
                    },
                ],
                "Test Savings",
            )
        )

    fetched = _fetch_tx(assert_bridge, account_id, "2020-06-01", "2020-07-31")
    by_id = {t.get("imported_id"): t for t in fetched}

    # Assertion B: on/before the boundary is filtered out (reconciled range
    # never disturbed).
    assert before_id not in by_id, (
        "source tx dated 2020-06-15 (<= reconciled boundary 2020-06-30) "
        "must be filtered out"
    )
    # Assertion C: after the boundary still imports — the filter isn't silently
    # dropping everything.
    assert after_id in by_id, (
        "source tx dated 2020-07-15 (> boundary) must import"
    )


def test_suspicious_match_assigns_review_category(
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    review_category_id: str,
    run_tag: str,
) -> None:
    """Source row that looks like a duplicate of an existing tx (same
    amount/date, different imported_id) must be imported with the review
    category set, not silently merged or dropped (ADR-006)."""
    account_id = account_ids["Test Credit Card"]
    seed_id = f"seed-{run_tag}"
    src_id = f"src-{run_tag}"
    same_date = "2031-03-15"
    same_amount_cents = -1234

    # Pre-seed a tx on the target date+amount and push it to the server so
    # the importer's bridge sees it when it downloads the budget.
    _seed_tx(
        assert_bridge,
        account_id,
        [
            {
                "date": same_date,
                "amount": same_amount_cents,
                "imported_id": seed_id,
                "payee_name": "Seed",
                "notes": "pre-seeded by integration test",
            }
        ],
    )

    with _make_importer() as imp:
        imp.import_transactions(
            _result(
                [
                    {
                        "date": same_date,
                        "payee": "Source",
                        "debit": 12.34,
                        "reference": src_id,
                    }
                ],
                "Test Credit Card",
            )
        )

    fetched = _fetch_tx(assert_bridge, account_id, same_date, same_date)
    by_id = {t.get("imported_id"): t for t in fetched}
    assert seed_id in by_id, "pre-seed disappeared"
    assert src_id in by_id, "source tx not imported (should be suspicious, not skipped)"
    assert by_id[src_id]["category"] == review_category_id, (
        f"source tx should carry review category {review_category_id!r}, "
        f"got {by_id[src_id].get('category')!r}"
    )
    assert by_id[src_id]["amount"] == same_amount_cents


def test_circuit_breaker_aborts_batch_atomically(
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    run_tag: str,
) -> None:
    """When suspicious count exceeds the per-batch threshold, the batch is
    aborted before any source tx is written — atomicity per ADR-002."""
    account_id = account_ids["Test Savings"]
    seed_id = f"seed-cb-{run_tag}"
    same_date = "2033-04-15"
    same_amount_cents = -2200

    _seed_tx(
        assert_bridge,
        account_id,
        [
            {
                "date": same_date,
                "amount": same_amount_cents,
                "imported_id": seed_id,
                "payee_name": "CB seed",
            }
        ],
    )

    # 6 source tx all matching the seed by amount/date → 6 suspicious;
    # threshold default = 5 → trip.
    rows = [
        {
            "date": same_date,
            "payee": f"src-{i}",
            "debit": 22.00,
            "reference": f"src-cb-{run_tag}-{i}",
        }
        for i in range(6)
    ]
    with _make_importer() as imp:
        imp.import_transactions(_result(rows, "Test Savings"))

    fetched = _fetch_tx(assert_bridge, account_id, same_date, same_date)
    src_in_actual = [
        t
        for t in fetched
        if (t.get("imported_id") or "").startswith(f"src-cb-{run_tag}-")
    ]
    assert src_in_actual == [], (
        "circuit breaker should have aborted before importing any source tx; "
        f"found {len(src_in_actual)} in Actual"
    )
    # Seed must still be there (we didn't roll it back).
    assert any(t.get("imported_id") == seed_id for t in fetched), (
        "pre-seed disappeared — only the source batch should have been aborted"
    )


def test_balance_match_at_checkpoint_lets_subsequent_batches_through(
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    review_category_id: str,  # noqa: ARG001  ensures fixture available for re-runs
    run_tag: str,
) -> None:
    """When a CAMT checkpoint balance matches Actual's balance at the
    boundary, the importer continues to the next batch (ADR-005)."""
    account_id = account_ids["Test Checking"]
    # Capture both cutoffs *before* importing so the after-import asserts use
    # consistent baselines: across re-runs the test budget keeps accumulating
    # data, so the asserts must be relative.
    pre_balance_jan_end = _fetch_balance(assert_bridge, account_id, "2032-01-31")
    pre_balance_feb_end = _fetch_balance(assert_bridge, account_id, "2032-02-29")
    jan_delta_cents = -1000 + 5000 - 500  # 3500
    feb_delta_cents = -2000 + 10000  # 8000

    rows = [
        {
            "date": "2032-01-05",
            "payee": "J1",
            "debit": 10.00,
            "reference": f"{run_tag}-j1",
        },
        {
            "date": "2032-01-15",
            "payee": "J2",
            "credit": 50.00,
            "reference": f"{run_tag}-j2",
        },
        {
            "date": "2032-01-25",
            "payee": "J3",
            "debit": 5.00,
            "reference": f"{run_tag}-j3",
        },
        {
            "date": "2032-02-05",
            "payee": "F1",
            "debit": 20.00,
            "reference": f"{run_tag}-f1",
        },
        {
            "date": "2032-02-15",
            "payee": "F2",
            "credit": 100.00,
            "reference": f"{run_tag}-f2",
        },
    ]
    checkpoint = BalanceCheckpoint(
        date=dt.date(2032, 1, 31),
        amount=(pre_balance_jan_end + jan_delta_cents) / 100.0,
    )

    with _make_importer() as imp:
        imp.import_transactions(_result(rows, "Test Checking"), [checkpoint])

    fetched = _fetch_tx(assert_bridge, account_id, "2032-01-01", "2032-02-29")
    mine = {t["imported_id"]: t for t in _scoped(fetched, run_tag)}
    assert set(mine) == {f"{run_tag}-{k}" for k in ("j1", "j2", "j3", "f1", "f2")}, (
        "balance match should have allowed all 5 tx through both batches"
    )

    # Each cutoff's post-balance equals its own pre-balance plus *this run's*
    # deltas up to that cutoff. (Comparing across cutoffs would catch
    # pre-existing tx between Jan-31 and Feb-29 from earlier runs.)
    assert (
        _fetch_balance(assert_bridge, account_id, "2032-01-31")
        == pre_balance_jan_end + jan_delta_cents
    )
    assert (
        _fetch_balance(assert_bridge, account_id, "2032-02-29")
        == pre_balance_feb_end + jan_delta_cents + feb_delta_cents
    )


def test_balance_mismatch_at_checkpoint_aborts_account(
    assert_bridge: ActualBridge,
    account_ids: dict[str, str],
    review_category_id: str,  # noqa: ARG001  ensures fixture available for re-runs
    run_tag: str,
) -> None:
    """Wrong checkpoint at month-end: batch 1 commits (it always does — ADR-
    005 calls it "the small recent gap"), then the account stops; batch 2
    must not be written."""
    account_id = account_ids["Test Credit Card"]
    pre_balance = _fetch_balance(assert_bridge, account_id, "2034-05-31")
    may_delta_cents = -1000 + 5000  # 4000

    rows = [
        {
            "date": "2034-05-05",
            "payee": "M1",
            "debit": 10.00,
            "reference": f"{run_tag}-m1",
        },
        {
            "date": "2034-05-20",
            "payee": "M2",
            "credit": 50.00,
            "reference": f"{run_tag}-m2",
        },
        # June batch — must NOT be imported (account stops at May checkpoint).
        {
            "date": "2034-06-10",
            "payee": "J1",
            "debit": 20.00,
            "reference": f"{run_tag}-j1",
        },
        {
            "date": "2034-06-20",
            "payee": "J2",
            "credit": 80.00,
            "reference": f"{run_tag}-j2",
        },
    ]
    # Off by 99.99 CHF intentionally.
    bad_checkpoint = BalanceCheckpoint(
        date=dt.date(2034, 5, 31),
        amount=(pre_balance + may_delta_cents + 9999) / 100.0,
    )

    with _make_importer() as imp:
        imp.import_transactions(_result(rows, "Test Credit Card"), [bad_checkpoint])

    fetched = _fetch_tx(assert_bridge, account_id, "2034-05-01", "2034-06-30")
    mine = {t["imported_id"]: t for t in _scoped(fetched, run_tag)}
    assert f"{run_tag}-m1" in mine, "May batch should have committed before the check"
    assert f"{run_tag}-m2" in mine, "May batch should have committed before the check"
    assert f"{run_tag}-j1" not in mine, (
        "June batch must be skipped after a May balance mismatch"
    )
    assert f"{run_tag}-j2" not in mine, (
        "June batch must be skipped after a May balance mismatch"
    )
