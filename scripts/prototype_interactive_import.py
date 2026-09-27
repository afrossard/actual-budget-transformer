#!/usr/bin/env python3
"""PROTOTYPE - throwaway. Interactive per-transaction import loop (issue #38).

THE QUESTION THIS ANSWERS
-------------------------
An interactive loop that only asks "import this one?" hides the two cases where
the importer throws bank data away. So the loop has to render what it *declined*
to import, not only what it proposes to add. Does showing that build trust, or
does it just create noise?

Three structurally different answers, switchable live with `v`:

  A  Tape     - three lines per transaction, keystroke at the bottom. Compact.
                Every row is prompted, declines included: dropping bank data is
                a decision, so it is never taken for you.
  B  Card     - one screen per transaction, source row / decision / write, with
                the raw records behind `?`. Slow; nothing gets past you.
  C  Triage   - no per-transaction walk at all. A manifest, then one question
                per group, then individual prompts for the contested ones only.
                Exception handling rather than a walk.

Runs against the throwaway Actual server, not a fixture, so the buckets come
out of the real `classify_transactions` and the real reconciliation filter:

    docker compose -f .devcontainer/docker-compose.yml \
        --profile actual up -d actual-server
    ACTUAL_SERVER_URL=http://localhost:5006 npm run bootstrap
    uv run python scripts/prototype_interactive_import.py --variant A

/data is tmpfs, so restart the container for a clean slate. Nothing here is
production code: no tests, no error handling, one file, delete when #38 closes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import sys
import termios
import time
import tty
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from actual_budget_transformer.actual_api import ActualBridge
from actual_budget_transformer.logging_config import logger as pkg_logger
from actual_budget_transformer.writers.actual_budget_importer import (
    classify_transactions,
    df_to_actual_txs,
)

SERVER_URL = os.environ.get("ACTUAL_SERVER_URL", "http://localhost:5006")
PASSWORD = os.environ.get("ACTUAL_PASSWORD", "test-password")
BUDGET_NAME = os.environ.get("ACTUAL_BUDGET_NAME", "Test Budget")
ACCOUNT = os.environ.get("PROTO_ACCOUNT", "Test Checking")
REVIEW_CATEGORY = "To Review"
SUSPICIOUS_THRESHOLD = 5  # config default; the breaker trips *above* this

# --------------------------------------------------------------------------
# terminal
# --------------------------------------------------------------------------

DIM, RED, YEL, GRN, CYA, BLD, OFF = (
    "\033[2m",
    "\033[31m",
    "\033[33m",
    "\033[32m",
    "\033[36m",
    "\033[1m",
    "\033[0m",
)
BUCKET_COLOUR = {"clean": GRN, "suspicious": YEL, "skip": CYA, "locked": DIM}
BUCKET_SIGIL = {"clean": "+", "suspicious": "?", "skip": "=", "locked": "#"}


class Keys:
    """Single keystroke if we have a tty, scripted keys when driven headless."""

    def __init__(self, script: str | None) -> None:
        self.queue = [k for k in (script or "").split(",") if k]
        self.tty = sys.stdin.isatty() and not self.queue

    def get(self) -> str:
        if self.queue:
            k = self.queue.pop(0)
            print(f"{DIM}[scripted: {k}]{OFF}")
            return k
        if not self.tty:
            return "q"
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        print()
        return "q" if ch in ("\x03", "\x04") else ch.lower()


def money(cents: int) -> str:
    return f"{cents / 100:>10,.2f}"


# --------------------------------------------------------------------------
# the scenario: a plausible UBS month, built to hit every bucket
# --------------------------------------------------------------------------

COL = ["transaction_date", "payee", "notes", "debit", "credit", "reference"]


def scenario_source() -> pd.DataFrame:
    """Source transactions as a processor would hand them over."""
    r: list[tuple] = [
        # dated inside the already-reconciled range -> dropped before any prompt
        ("2020-06-15", "COOP CITY", "Carte", 42.10, 0, "T-9001"),
        ("2031-03-02", "MIGROS", "Carte", 23.45, 0, "T-0001"),
        ("2031-03-03", "SBB TICKET", "Carte", 8.60, 0, "T-0002"),
        # same imported_id already in Actual -> skip
        ("2031-03-04", "SALARY ACME SA", "Virement", 0, 6500.00, "T-0003"),
        # a manually-entered -64.00 sits on 03-06 in Actual -> blind duplicate
        ("2031-03-05", "RESTAURANT DES ALPES", "Carte", 64.00, 0, "T-0004"),
        # five equal-amount consecutive days, and Actual already holds one on
        # 03-09: the #50 false-positive cascade
        ("2031-03-10", "CAFE LUGANO", "Carte", 4.50, 0, "T-0005"),
        ("2031-03-11", "CAFE LUGANO", "Carte", 4.50, 0, "T-0006"),
        ("2031-03-12", "CAFE LUGANO", "Carte", 4.50, 0, "T-0007"),
        ("2031-03-13", "CAFE LUGANO", "Carte", 4.50, 0, "T-0008"),
        ("2031-03-14", "CAFE LUGANO", "Carte", 4.50, 0, "T-0009"),
        # Two real purchases with identical attributes and no bank reference,
        # so `_stable_id` mints the same imported ID for both. The classifier
        # calls both Clean (it never compares source rows with each other) and
        # Actual then absorbs the second one (#49). The bank's file says two,
        # so two is the correct outcome: this is what `force a separate
        # transaction` is for.
        #
        # Reachability: cards always carry a minted reference (occurrence
        # counter), and the account CSV carries `N° de transaction` - whether
        # that column is ever empty is unverified.
        ("2031-03-20", "PHARMACIE CENTRALE", "", 19.90, 0, ""),
        ("2031-03-20", "PHARMACIE CENTRALE", "", 19.90, 0, ""),
        ("2031-03-25", "UBS TWINT", "Motif: loyer", 150.00, 0, "T-0010"),
    ]
    df = pd.DataFrame(r, columns=COL)
    df["transaction_date"] = pd.to_datetime(df["transaction_date"])
    return df


SEED_MARKER = "proto38-seeded"


def seed_actual(bridge: ActualBridge, account_id: str) -> None:
    """Put the pre-existing Actual state in place. Idempotent via a marker."""
    existing = bridge.get_transactions(account_id, "1900-01-01", "2099-12-31")
    if any(t.get("imported_id") == SEED_MARKER for t in existing):
        print(f"{DIM}Actual already seeded for this prototype.{OFF}")
        return

    print("Seeding the throwaway budget ...")
    bridge.import_transactions(
        account_id,
        [
            {
                "date": "2020-06-30",
                "amount": -12000,
                "imported_id": "proto38-reconciled",
                "payee_name": "OLD RECONCILED TX",
                "notes": "marked reconciled below -> sets the boundary",
            },
            {
                "date": "2031-03-04",
                "amount": 650000,
                "imported_id": "T-0003",
                "payee_name": "SALARY ACME SA",
                "notes": "imported on a previous run",
            },
            {
                "date": "2031-03-01",
                "amount": -100,
                "imported_id": SEED_MARKER,
                "payee_name": "PROTOTYPE MARKER",
                "notes": "so re-runs do not re-seed",
            },
        ],
    )
    # hand-entered rows: no imported_id, which is what makes them blind
    # duplicates rather than skips. The restaurant one is split across two
    # categories, so `f` can be watched against a split.
    for date, cents, payee, subs in [
        ("2031-03-06", -6400, "Restaurant (typed by hand)", [-4000, -2400]),
        ("2031-03-09", -450, "Coffee (typed by hand)", None),
    ]:
        tx: dict[str, Any] = {
            "date": date,
            "amount": cents,
            "payee_name": payee,
            "notes": "manual",
        }
        if subs:
            tx["subtransactions"] = [{"amount": a} for a in subs]
        bridge.import_transactions(account_id, [tx])
    bridge.sync()

    for t in bridge.get_transactions(account_id, "2020-06-01", "2020-07-01"):
        if t.get("imported_id") == "proto38-reconciled":
            bridge.update_transaction(t["id"], {"reconciled": True})
    bridge.sync()
    print(f"{DIM}Seeded. Reconciliation boundary is now 2020-06-30.{OFF}\n")


# --------------------------------------------------------------------------
# classification + the evidence the real classifier throws away
# --------------------------------------------------------------------------


@dataclass
class Row:
    tx: dict[str, Any]
    bucket: str
    basis: str = ""
    match: dict[str, Any] | None = None
    twin_of: str | None = None
    outcome: str = "pending"  # pending | imported | declined | unreached

    @property
    def date(self) -> dt.date:
        return dt.date.fromisoformat(self.tx["date"])


@dataclass
class Session:
    rows: list[Row] = field(default_factory=list)
    write_ms: list[float] = field(default_factory=list)
    breaker_ack: bool = False

    @property
    def suspicious_confirmed(self) -> int:
        return sum(
            1
            for r in self.rows
            if r.bucket == "suspicious"
            and r.outcome in ("imported", "swallowed", "fixed", "forced")
        )


def reconciliation_date(bridge: ActualBridge, account_id: str) -> dt.date | None:
    txs = bridge.get_transactions(account_id, "1900-01-01", dt.date.today().isoformat())
    dates = [
        dt.date.fromisoformat(t["date"])
        for t in txs
        if t.get("reconciled") and t.get("date")
    ]
    return max(dates) if dates else None


def explain(
    tx: dict[str, Any], existing: list[dict[str, Any]], seen: dict[str, str]
) -> tuple[str, dict[str, Any] | None, str | None]:
    """Why the classifier landed where it did - the bit it does not return."""
    for t in existing:
        if t.get("imported_id") and t["imported_id"] == tx["imported_id"]:
            return (
                f"imported_id {tx['imported_id']} already in Actual",
                t,
                None,
            )
    twin = seen.get(tx["imported_id"])
    if twin:
        return (
            f"imported_id {tx['imported_id']} is identical to an earlier row "
            "in this same file",
            None,
            twin,
        )
    d = dt.date.fromisoformat(tx["date"])
    for t in existing:
        if t.get("amount") is None or not t.get("date"):
            continue
        if int(t["amount"]) == int(tx["amount"]):
            delta = abs((dt.date.fromisoformat(t["date"]) - d).days)
            if delta <= 1:
                how = "same day" if delta == 0 else f"{delta} day apart"
                src = (
                    "no imported_id (hand-entered)"
                    if not t.get("imported_id")
                    else f"imported_id {t['imported_id']}"
                )
                return (f"same amount, {how}, {src}", t, None)
    return ("no match in Actual", None, None)


def build_rows(
    bridge: ActualBridge, account_id: str, df: pd.DataFrame, rec_date: dt.date | None
) -> list[Row]:
    txs = df_to_actual_txs(df)
    rows: list[Row] = []
    live: list[dict[str, Any]] = []
    for t in txs:
        if rec_date and dt.date.fromisoformat(t["date"]) <= rec_date:
            rows.append(
                Row(
                    tx=t,
                    bucket="locked",
                    basis=(
                        f"dated on/before the reconciliation boundary {rec_date}; "
                        "the importer drops it with a log line only"
                    ),
                )
            )
        else:
            live.append(t)

    dates = [dt.date.fromisoformat(t["date"]) for t in live]
    existing = bridge.get_transactions(
        account_id,
        (min(dates) - dt.timedelta(days=1)).isoformat(),
        (max(dates) + dt.timedelta(days=1)).isoformat(),
    )
    clean, suspicious, skipped = classify_transactions(live, existing)
    bucket_of = {id(t): "clean" for t in clean}
    bucket_of.update({id(t): "suspicious" for t in suspicious})
    bucket_of.update({id(t): "skip" for t in skipped})

    seen: dict[str, str] = {}
    for t in live:
        basis, match, twin = explain(t, existing, seen)
        rows.append(
            Row(tx=t, bucket=bucket_of[id(t)], basis=basis, match=match, twin_of=twin)
        )
        seen.setdefault(t["imported_id"], f"{t['date']} {t['payee_name']}")
    rows.sort(key=lambda r: r.date)
    return rows


def reclassify(
    bridge: ActualBridge, account_id: str, row: Row, seen: dict[str, str]
) -> None:
    """Re-read Actual right before prompting - shows the cascade."""
    if row.bucket == "locked":
        return
    d = row.date
    existing = bridge.get_transactions(
        account_id,
        (d - dt.timedelta(days=2)).isoformat(),
        (d + dt.timedelta(days=2)).isoformat(),
    )
    clean, suspicious, skipped = classify_transactions([row.tx], existing)
    row.bucket = "clean" if clean else "suspicious" if suspicious else "skip"
    row.basis, row.match, row.twin_of = explain(row.tx, existing, seen)


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------


def _window(
    bridge: ActualBridge, account_id: str, row: Row, days: int = 8
) -> dict[str, dict[str, Any]]:
    """Every Actual transaction near this date, by id - a pre-write snapshot.

    Taken before each write so that a merge Actual performs on its own can be
    undone field by field. Costs one read (a few ms).
    """
    d = row.date
    return {
        t["id"]: t
        for t in bridge.get_transactions(
            account_id,
            (d - dt.timedelta(days=days)).isoformat(),
            (d + dt.timedelta(days=days)).isoformat(),
        )
        if t.get("id")
    }


def splits_of(t: dict[str, Any]) -> list[dict[str, Any]]:
    return t.get("subtransactions") or []


def show_actual_row(t: dict[str, Any], label: str) -> None:
    subs = splits_of(t)
    # imported_payee is the raw name the import wrote; the payee *link* is a
    # separate field that a merge leaves alone. Labelling it "payee" would
    # overstate what a merge changes.
    print(
        f"    {DIM}{label:<9}{OFF}{t.get('date')} "
        f"{money(int(t.get('amount') or 0))} "
        f"imported_payee={t.get('imported_payee') or '?'} "
        f"notes={t.get('notes') or '-'} "
        f"imported_id={t.get('imported_id') or '(none)'} "
        f"category={'set' if t.get('category') else 'none'}"
    )
    if subs:
        amounts = " / ".join(money(int(x.get("amount") or 0)).strip() for x in subs)
        print(f"    {DIM}{'':<9}{OFF}{CYA}split into {len(subs)}: {amounts}{OFF}")


def mint_id(imported_id: str, attempt: int) -> str:
    """A minted imported ID, so the bank's n-th copy looks distinct to Actual.

    Same idea as the cards processor's occurrence counter, applied at import
    time instead of parse time.
    """
    return f"{imported_id}-{attempt + 1}"


def force_new_entry(
    bridge: ActualBridge,
    account_id: str,
    row: Row,
    ses: Session,
    merged_into: str | None,
    before: dict[str, Any] | None,
) -> None:
    """Make Actual create a separate transaction, and undo its merge.

    The bank's file says there are n transactions with these attributes, so n
    transactions is the correct outcome. Actual disagreed and merged. This
    mints a distinct imported ID until Actual adds a row, then restores the
    transaction it had modified to exactly the state captured before the write.
    """
    base = row.tx["imported_id"]
    for attempt in range(1, 6):
        tx = dict(row.tx)
        tx["imported_id"] = mint_id(base, attempt)
        t0 = time.monotonic()
        res = bridge.import_transactions(account_id, [tx])
        bridge.sync()
        ses.write_ms.append((time.monotonic() - t0) * 1000)
        if res.get("added"):
            row.outcome = "forced"
            print(
                f"  {GRN}forced a separate transaction{OFF} "
                f"(added=1, minted imported_id={tx['imported_id']})"
            )
            break
        print(f"  {DIM}Actual merged {tx['imported_id']} too; minting again{OFF}")
    else:
        row.outcome = "swallowed"
        print(f"  {RED}gave up after 5 minted IDs{OFF} - Actual absorbed each one")
        return

    if not (merged_into and before):
        print(
            f"  {YEL}note{OFF}: the first attempt modified a transaction that "
            "was not captured, so it stays as Actual left it."
        )
        return

    bridge.update_transaction(
        merged_into,
        {
            "date": before.get("date"),
            "payee": before.get("payee"),
            "imported_payee": before.get("imported_payee"),
            "notes": before.get("notes"),
            "imported_id": before.get("imported_id"),
            "category": before.get("category"),
        },
    )
    bridge.sync()
    restored = _window(bridge, account_id, row).get(merged_into)
    print(f"  {GRN}restored the transaction Actual had modified{OFF}:")
    if restored:
        show_actual_row(restored, "now")


def do_import(
    bridge: ActualBridge,
    account_id: str,
    row: Row,
    review_cat: str | None,
    ses: Session,
    keys: Keys,
) -> None:
    tx = dict(row.tx)
    if row.bucket == "suspicious" and review_cat:
        tx["category"] = review_cat
    snapshot = _window(bridge, account_id, row)
    t0 = time.monotonic()
    res = bridge.import_transactions(account_id, [tx])
    bridge.sync()
    ms = (time.monotonic() - t0) * 1000
    ses.write_ms.append(ms)

    added = len(res.get("added") or [])
    updated = res.get("updated") or []
    errs = res.get("errors") or []
    if errs:
        row.outcome = "declined"
        print(f"  {RED}refused{OFF} by Actual: {errs}")
        return
    if added:
        row.outcome = "imported"
        print(f"  {GRN}written{OFF} (added=1, {ms:.0f} ms incl. sync)")
        return

    # Actual accepted the call and created nothing: its own matcher merged this
    # onto an existing transaction. The loop must not call that "imported" -
    # it is a second place where bank data disappears.
    row.outcome = "swallowed"
    merged_into = updated[0] if updated else None
    print(
        f"  {RED}nothing created{OFF} (added=0 updated={len(updated)}, "
        f"{ms:.0f} ms) - Actual merged this into a transaction it already had"
    )
    now = _window(bridge, account_id, row, days=3)
    if merged_into:
        was = snapshot.get(merged_into)
        if was:
            show_actual_row(was, "was")
        if merged_into in now:
            show_actual_row(now[merged_into], "now")
    else:
        for t in now.values():
            if int(t.get("amount") or 0) == int(tx["amount"]):
                show_actual_row(t, "in Actual")

    print(
        f"  {BLD}force a separate transaction? [y/n] {OFF}",
        end="",
        flush=True,
    )
    if keys.get() == "y":
        force_new_entry(
            bridge,
            account_id,
            row,
            ses,
            merged_into,
            snapshot.get(merged_into) if merged_into else None,
        )
    else:
        print(f"  {DIM}left as Actual merged it{OFF}")


def do_fix(
    bridge: ActualBridge,
    account_id: str,
    row: Row,
    ses: Session,
) -> None:
    """Correct the matched Actual transaction from the source transaction.

    For when the row already in Actual is a bad hand entry and the bank's copy
    is the truth. Two steps, both on commands the bridge already has: let
    Actual's own matcher merge (it stamps the imported ID and overwrites
    imported_payee, and leaves date, amount, payee link, category and notes
    alone), then patch the fields the bank is authoritative on - the date and
    the notes.

    Split-safe by construction: it patches the parent's own fields only. The
    amount is never written, so a split's parts always still sum to the parent.
    A source amount that differs from the stored amount is reported, not
    applied - what to do there is an open question.
    """
    assert row.match is not None
    before = dict(row.match)
    subs = splits_of(before)
    if subs:
        print(
            f"  {CYA}this transaction is split into {len(subs)} categories{OFF} "
            "- only the parent's date and notes are patched, the parts are "
            "left exactly as they are"
        )
    if int(before.get("amount") or 0) != int(row.tx["amount"]):
        print(
            f"  {YEL}amounts differ{OFF}: Actual holds "
            f"{money(int(before.get('amount') or 0)).strip()}, the bank says "
            f"{money(int(row.tx['amount'])).strip()}. The amount is left "
            f"untouched"
            + (" - patching it would break the split's sum." if subs else ".")
        )
    t0 = time.monotonic()
    res = bridge.import_transactions(account_id, [dict(row.tx)])
    updated = res.get("updated") or []
    added = res.get("added") or []
    if not updated:
        ses.write_ms.append((time.monotonic() - t0) * 1000)
        row.outcome = "imported" if added else "declined"
        print(
            f"  {RED}not corrected{OFF}: Actual did not match this onto the row "
            f"above (added={len(added)}). It created a new transaction instead, "
            "so there was nothing to correct."
        )
        return
    target = updated[0]
    if target != before.get("id"):
        print(
            f"  {YEL}note{OFF}: Actual matched a different row than the one "
            f"shown ({target})."
        )
    bridge.update_transaction(
        target, {"date": row.tx["date"], "notes": row.tx["notes"]}
    )
    bridge.sync()
    ses.write_ms.append((time.monotonic() - t0) * 1000)
    row.outcome = "fixed"

    d = row.date
    after = next(
        (
            t
            for t in bridge.get_transactions(
                account_id,
                (d - dt.timedelta(days=8)).isoformat(),
                (d + dt.timedelta(days=8)).isoformat(),
            )
            if t.get("id") == target
        ),
        None,
    )
    print(f"  {GRN}corrected in place{OFF} - one transaction, the bank's data:")
    for label, t in (("was", before), ("now", after)):
        if t:
            show_actual_row(t, label)


def do_override(
    bridge: ActualBridge,
    account_id: str,
    row: Row,
    ses: Session,
    keys: Keys,
) -> None:
    """Import a source transaction the tool wanted to drop.

    The two declines need different handling, and neither is free:

    * Skip - the imported ID is already in Actual. Sending it again changes
      nothing, because Actual matches on that ID. So the override sends it
      under a distinct imported ID, which is the only way to get a second
      transaction. If the two really are the same purchase, you now own a
      duplicate.
    * Locked - the source transaction is inside the reconciled range. Importing
      it means your own reconciliation no longer matches the bank, and the
      importer's keystone rule (ADR-002: never touch a reconciled range) is
      the thing being overruled.
    """
    tx = dict(row.tx)
    if row.bucket == "skip":
        tx["imported_id"] = f"{tx['imported_id']}-override"
        warn = (
            "Actual holds this imported ID already. Importing under a new one "
            "gives you a second transaction - a real duplicate if it was the "
            "same purchase."
        )
    else:
        warn = (
            "This is dated inside the reconciled range. Importing it means "
            "your reconciliation up to that date no longer matches the bank."
        )
    print(f"  {RED}override{OFF}: {warn}")
    print(f"  {BLD}import it anyway? [y/n] {OFF}", end="", flush=True)
    if keys.get() != "y":
        row.outcome = "declined"
        print(f"  {DIM}dropped after all{OFF}")
        return

    t0 = time.monotonic()
    res = bridge.import_transactions(account_id, [tx])
    bridge.sync()
    ms = (time.monotonic() - t0) * 1000
    ses.write_ms.append(ms)
    added = len(res.get("added") or [])
    updated = len(res.get("updated") or [])
    errs = res.get("errors") or []
    if errs:
        row.outcome = "declined"
        print(f"  {RED}refused{OFF} by Actual: {errs}")
    elif added:
        row.outcome = "overridden"
        print(
            f"  {GRN}imported over the tool's advice{OFF} "
            f"(added=1, imported_id={tx['imported_id']}, {ms:.0f} ms)"
        )
    else:
        row.outcome = "swallowed"
        print(
            f"  {RED}nothing created{OFF} (added=0 updated={updated}) - Actual "
            "matched it onto a transaction it already had"
        )


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------


def line(row: Row, idx: int, total: int) -> str:
    c = BUCKET_COLOUR[row.bucket]
    return (
        f"{c}{BUCKET_SIGIL[row.bucket]}{OFF} {DIM}{idx:>2}/{total}{OFF} "
        f"{row.tx['date']}  {row.tx['payee_name'][:28]:<28} "
        f"{money(row.tx['amount'])}  {c}{row.bucket}{OFF}"
    )


def detail(row: Row) -> None:
    print(
        f"  {DIM}source   {OFF}notes={row.tx['notes'] or '-'!s:<30} "
        f"imported_id={row.tx['imported_id'] or '(none)'}"
    )
    print(f"  {DIM}why      {OFF}{row.basis}")
    if row.match:
        m = row.match
        print(
            f"  {DIM}matched  {OFF}Actual: {m.get('date')} "
            f"{money(int(m.get('amount') or 0))} "
            f"imported_payee={m.get('imported_payee') or '?'} "
            f"reconciled={bool(m.get('reconciled'))}"
        )
        if splits_of(m):
            amounts = " / ".join(
                money(int(x.get("amount") or 0)).strip() for x in splits_of(m)
            )
            print(
                f"  {DIM}splits   {OFF}{CYA}{len(splits_of(m))} categories: "
                f"{amounts} - never touched{OFF}"
            )
    if row.twin_of:
        print(
            f"  {DIM}twin of  {OFF}{row.twin_of} {RED}(second copy is real "
            f"bank data){OFF}"
        )
    if row.bucket in ("clean", "suspicious"):
        cat = " + review category" if row.bucket == "suspicious" else ""
        print(
            f"  {DIM}write    {OFF}{row.tx['date']} {money(row.tx['amount'])} "
            f"{row.tx['payee_name']}{cat}"
        )
    else:
        print(f"  {DIM}write    {OFF}{RED}nothing - this bank row is dropped{OFF}")


def deep_detail(row: Row) -> None:
    """Everything, unformatted - for when the summary is not enough."""
    print(f"  {DIM}raw source row{OFF}")
    for k, v in row.tx.items():
        print(f"    {k:<12} {v!r}")
    if row.match:
        print(f"  {DIM}raw matched Actual row{OFF}")
        for k, v in row.match.items():
            if k in ("subtransactions", "schedule", "raw_synced_data"):
                continue
            print(f"    {k:<12} {v!r}")


def header(variant: str, ses: Session, account: str) -> None:
    names = {"A": "Tape", "B": "Card", "C": "Triage"}
    done = sum(1 for r in ses.rows if r.outcome != "pending")
    print(
        f"{BLD}#38 interactive import prototype{OFF}  "
        f"variant {variant} ({names[variant]})   account {account}   "
        f"{done}/{len(ses.rows)} seen   "
        f"suspicious imported {ses.suspicious_confirmed}/{SUSPICIOUS_THRESHOLD}"
    )
    print(
        f"{DIM}y import   f correct the matched row   o import anyway"
        f"   n leave   ? detail   v variant   q stop"
        f"   (+ clean  ? suspicious  = skip  # locked){OFF}"
    )
    print("-" * 78)


# --------------------------------------------------------------------------
# variants
# --------------------------------------------------------------------------


def ask(
    row: Row,
    idx: int,
    ses: Session,
    keys: Keys,
    bridge: ActualBridge,
    account_id: str,
    review_cat: str | None,
    show_detail: bool,
) -> str:
    """One prompt. Returns 'next' | 'quit' | 'switch'."""
    print(line(row, idx, len(ses.rows)))
    declined = row.bucket in ("skip", "locked")
    if row.twin_of and not show_detail:
        # A Clean row that is a copy of an earlier row in the same file is not
        # clean. Warn before the write, not after it: both rows carry the same
        # imported ID, so Actual will absorb the second one silently.
        print(
            f"  {RED}same imported ID as an earlier row in this file{OFF} "
            f"({row.tx['imported_id']})"
        )
        print(f"  {DIM}earlier  {OFF}{row.twin_of}")
        print(
            f"  {DIM}so       {OFF}Actual will match this onto that one and "
            "create nothing, even though it is a second real purchase"
        )
    if show_detail:
        detail(row)
    elif declined:
        # A decline is the case where the tool drops bank data, so its
        # evidence goes on screen without being asked for.
        print(f"  {DIM}why      {OFF}{row.basis}")
        if row.match:
            m = row.match
            print(
                f"  {DIM}matched  {OFF}Actual: {m.get('date')} "
                f"{money(int(m.get('amount') or 0))} "
                f"payee={m.get('imported_payee') or '?'} "
                f"notes={m.get('notes') or '-'}"
            )
    while True:
        writable = row.bucket in ("clean", "suspicious")
        fixable = row.match is not None and writable
        allowed = ["y"] if writable else []
        if fixable:
            allowed.append("f")
        if declined:
            allowed.append("o")
        allowed += ["n", "?", "v", "q"]
        legal = "/".join(allowed)
        verb = "import" if writable else "drop it"
        print(f"  {BLD}{verb}? [{legal}] {OFF}", end="", flush=True)
        k = keys.get()
        if k == "q":
            return "quit"
        if k == "v":
            return "switch"
        if k == "?":
            if show_detail:
                deep_detail(row)
            else:
                detail(row)
            continue
        if k == "y" and writable:
            if (
                row.bucket == "suspicious"
                and ses.suspicious_confirmed >= SUSPICIOUS_THRESHOLD
                and not ses.breaker_ack
            ):
                print(
                    f"  {RED}circuit breaker{OFF}: "
                    f"{ses.suspicious_confirmed} suspicious already imported "
                    f"(threshold {SUSPICIOUS_THRESHOLD}). "
                    "In an unattended run the account would stop here."
                )
                print(f"  {BLD}keep going anyway? [y/q] {OFF}", end="", flush=True)
                if keys.get() != "y":
                    return "quit"
                ses.breaker_ack = True
            do_import(bridge, account_id, row, review_cat, ses, keys)
            return "next"
        if k == "y" and not writable:
            print(
                f"  {DIM}y is for a row the tool proposes to import. This one "
                f"it proposes to drop: o imports it anyway, n agrees to drop "
                f"it{OFF}"
            )
            continue
        if k == "o" and declined:
            do_override(bridge, account_id, row, ses, keys)
            return "next"
        if k == "f" and fixable:
            do_fix(bridge, account_id, row, ses)
            return "next"
        if k == "n":
            row.outcome = "declined"
            print(
                f"  {DIM}dropped - this bank row is not in Actual{OFF}"
                if declined
                else f"  {DIM}left alone{OFF}"
            )
            return "next"
        shown = repr(k) if k.isprintable() and k.strip() else f"key {k!r}"
        print(f"  {DIM}{shown} does nothing here - use {legal}{OFF}")


def variant_a(ctx: dict[str, Any]) -> str:
    """Tape: one line per source transaction, and every one of them stops you.

    It used to let the Skip and Locked rows scroll past unprompted. That was
    wrong: dropping bank data is a decision, so it gets a prompt like any
    other.
    """
    ses, keys = ctx["ses"], ctx["keys"]
    while ctx["i"] < len(ses.rows):
        row = ses.rows[ctx["i"]]
        if ctx["mode"] == "per-tx":
            reclassify(ctx["bridge"], ctx["account_id"], row, ctx["seen"])
        idx = ctx["i"] + 1
        r = ask(
            row,
            idx,
            ses,
            keys,
            ctx["bridge"],
            ctx["account_id"],
            ctx["review_cat"],
            show_detail=False,
        )
        if r != "next":
            return r
        ctx["i"] += 1
    return "done"


def variant_b(ctx: dict[str, Any]) -> str:
    """Card: one screen each, full detail, prompts on every single row."""
    ses, keys = ctx["ses"], ctx["keys"]
    while ctx["i"] < len(ses.rows):
        row = ses.rows[ctx["i"]]
        if ctx["mode"] == "per-tx":
            reclassify(ctx["bridge"], ctx["account_id"], row, ctx["seen"])
        print("\033[2J\033[H", end="")
        header("B", ses, ctx["account"])
        r = ask(
            row,
            ctx["i"] + 1,
            ses,
            keys,
            ctx["bridge"],
            ctx["account_id"],
            ctx["review_cat"],
            show_detail=True,
        )
        if r != "next":
            return r
        ctx["i"] += 1
    return "done"


def variant_c(ctx: dict[str, Any]) -> str:
    """Triage: manifest, one question per group, individuals only if contested."""
    ses, keys = ctx["ses"], ctx["keys"]
    pending = [r for r in ses.rows if r.outcome == "pending"]
    groups = {
        b: [r for r in pending if r.bucket == b]
        for b in ("clean", "suspicious", "skip", "locked")
    }
    print(f"{BLD}This file, classified{OFF}")
    for b, rows in groups.items():
        if not rows:
            continue
        total = sum(r.tx["amount"] for r in rows)
        verb = {
            "clean": "would be imported",
            "suspicious": "would be imported with the review category",
            "skip": f"{RED}would be dropped{OFF} - already in Actual",
            "locked": f"{RED}would be dropped{OFF} - inside the reconciled range",
        }[b]
        print(
            f"  {BUCKET_COLOUR[b]}{BUCKET_SIGIL[b]} {len(rows):>2} {b:<11}{OFF}"
            f"{money(total)}  {verb}"
        )
    print("-" * 78)

    for b in ("clean", "suspicious", "skip", "locked"):
        rows = groups[b]
        if not rows:
            continue
        act = "import" if b in ("clean", "suspicious") else "accept dropping"
        print(
            f"{BLD}{act} all {len(rows)} {b}?{OFF} [y=all / e=one by one / q] ",
            end="",
            flush=True,
        )
        k = keys.get()
        if k == "q":
            return "quit"
        if k == "y":
            for row in rows:
                if b in ("clean", "suspicious"):
                    do_import(
                        ctx["bridge"],
                        ctx["account_id"],
                        row,
                        ctx["review_cat"],
                        ses,
                        keys,
                    )
                else:
                    row.outcome = "declined"
            print(f"  {DIM}{len(rows)} {b} handled in one keystroke{OFF}")
            continue
        for n, row in enumerate(rows, 1):
            r = ask(
                row,
                n,
                ses,
                keys,
                ctx["bridge"],
                ctx["account_id"],
                ctx["review_cat"],
                show_detail=True,
            )
            if r != "next":
                return r
    return "done"


VARIANTS = {"A": variant_a, "B": variant_b, "C": variant_c}


# --------------------------------------------------------------------------


def report(ses: Session, variant: str) -> None:
    print("\n" + "=" * 78)
    imported = [r for r in ses.rows if r.outcome == "imported"]
    fixed = [r for r in ses.rows if r.outcome == "fixed"]
    overridden = [r for r in ses.rows if r.outcome == "overridden"]
    forced = [r for r in ses.rows if r.outcome == "forced"]
    swallowed = [r for r in ses.rows if r.outcome == "swallowed"]
    declined = [r for r in ses.rows if r.outcome == "declined"]
    unseen = [r for r in ses.rows if r.outcome == "pending"]
    print(f"{BLD}Run over{OFF} (last variant {variant})")
    print(f"  new rows in Actual    : {len(imported)}")
    print(f"  corrected in place    : {len(fixed)}")
    print(f"  imported over advice  : {len(overridden)}")
    print(f"  forced past a merge   : {len(forced)}")
    print(f"  confirmed but merged  : {len(swallowed)}")
    print(f"  left alone            : {len(declined)}")
    print(f"  never reached         : {len(unseen)}")
    if swallowed:
        print(f"\n  {RED}you said import, Actual created nothing{OFF}:")
        for r in swallowed:
            print(
                f"    {r.tx['date']} {money(r.tx['amount'])} "
                f"{r.tx['payee_name']} - matched onto a row Actual already had"
            )
    dropped = [r for r in declined if r.bucket in ("skip", "locked")]
    if dropped:
        print(f"\n  {RED}bank rows this run threw away{OFF}:")
        for r in dropped:
            print(
                f"    {r.tx['date']} {money(r.tx['amount'])} "
                f"{r.tx['payee_name']} - {r.basis}"
            )
    if ses.write_ms:
        avg = sum(ses.write_ms) / len(ses.write_ms)
        print(
            f"\n  per-transaction write+sync: avg {avg:.0f} ms, "
            f"max {max(ses.write_ms):.0f} ms over {len(ses.write_ms)} writes"
        )
    if unseen:
        nxt = unseen[0]
        print(
            f"\n  {CYA}resume{OFF}: re-run the same file. Everything written "
            f"above comes back as {CYA}skip{OFF} on the imported_id, so the "
            f"loop restarts at {nxt.tx['date']} {nxt.tx['payee_name']} "
            "without a saved cursor."
        )
    print("=" * 78)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--variant", choices=list(VARIANTS), default="A")
    ap.add_argument(
        "--reclassify",
        choices=["batch", "per-tx"],
        default="batch",
        help="batch: classify once up front (what the importer does today). "
        "per-tx: re-read Actual before each prompt, so your own confirmed "
        "writes can make the next transaction suspicious (#50 cascade).",
    )
    ap.add_argument("--account", default=ACCOUNT)
    ap.add_argument("--script", help="comma-separated keys, for a headless smoke run")
    ap.add_argument(
        "--debug",
        action="store_true",
        help="show the bridge log. Off by default: the bridge forwards every "
        "line @actual-app/api writes to stderr at INFO, and Actual dumps a "
        "full transaction record on each write, which buries the prompt.",
    )
    args = ap.parse_args()

    if not args.debug:
        # The bridge drains the node process stderr into this logger at INFO
        # (actual_api.py:_drain_stderr), and Actual logs a whole transaction
        # record per write. That is unreadable in an interactive loop, so only
        # warnings and errors get through unless you ask for the rest.
        pkg_logger.setLevel(logging.WARNING)
        for h in pkg_logger.handlers:
            h.setLevel(logging.WARNING)

    print(__doc__.split("Runs against")[0])
    data_dir = "/tmp/proto38-data"
    os.makedirs(data_dir, exist_ok=True)
    with ActualBridge(
        server_url=SERVER_URL,
        password=PASSWORD,
        data_dir=data_dir,
        budget_name=BUDGET_NAME,
    ) as bridge:
        account = next(
            a
            for a in bridge.get_accounts()
            if a.get("name") == args.account and not a.get("closed")
        )
        seed_actual(bridge, account["id"])
        review_cat = next(
            (
                c["id"]
                for c in bridge.get_categories()
                if c.get("name") == REVIEW_CATEGORY
            ),
            None,
        )
        rec = reconciliation_date(bridge, account["id"])
        ses = Session(rows=build_rows(bridge, account["id"], scenario_source(), rec))

        ctx: dict[str, Any] = {
            "ses": ses,
            "keys": Keys(args.script),
            "bridge": bridge,
            "account_id": account["id"],
            "account": args.account,
            "review_cat": review_cat,
            "mode": args.reclassify,
            "i": 0,
            "seen": {},
        }
        variant = args.variant
        while True:
            print()
            header(variant, ses, args.account)
            if ctx["mode"] == "per-tx":
                print(f"{YEL}re-classifying before every prompt{OFF}")
            r = VARIANTS[variant](ctx)
            if r == "switch":
                order = list(VARIANTS)
                variant = order[(order.index(variant) + 1) % len(order)]
                continue
            break
        report(ses, variant)


if __name__ == "__main__":
    main()
