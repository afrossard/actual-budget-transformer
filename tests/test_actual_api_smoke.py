"""End-to-end smoke test for the JS-API bridge.

Preconditions (skipped if not met):
  * Actual server reachable at http://actual-server:5006
  * `npm install` has populated node_modules (provides tsx + @actual-app/api)
  * `npm run bootstrap` has created "Test Budget" with "Test Checking"

Mirrors the TS smoke test (tests/actual/import_roundtrip.test.ts) but drives
the bridge through the Python wrapper, validating the JSON-over-stdio surface.
"""

from __future__ import annotations

import os
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator

import pytest

from actual_budget_transformer.actual_api import ActualBridge, BridgeError

SERVER_URL = os.environ.get("ACTUAL_SERVER_URL", "http://actual-server:5006")
PASSWORD = os.environ.get("ACTUAL_PASSWORD", "test-password")
BUDGET_NAME = os.environ.get("ACTUAL_BUDGET_NAME", "Test Budget")


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


@pytest.fixture
def bridge() -> Iterator[ActualBridge]:
    with (
        tempfile.TemporaryDirectory(prefix="actual-bridge-test-") as data_dir,
        ActualBridge(
            server_url=SERVER_URL,
            password=PASSWORD,
            data_dir=data_dir,
            budget_name=BUDGET_NAME,
        ) as b,
    ):
        yield b


def _checking_id(bridge: ActualBridge) -> str:
    accounts = bridge.get_accounts()
    for a in accounts:
        if a.get("name") == "Test Checking":
            return a["id"]
    raise AssertionError(
        f"'Test Checking' not in {[a.get('name') for a in accounts]} — re-run bootstrap"
    )


def test_bridge_open_and_list_accounts(bridge: ActualBridge) -> None:
    accounts = bridge.get_accounts()
    names = {a["name"] for a in accounts if "name" in a}
    assert "Test Checking" in names, (
        f"expected 'Test Checking' in {names} — was `npm run bootstrap` run?"
    )


def test_bridge_unknown_budget_raises() -> None:
    with (
        tempfile.TemporaryDirectory(prefix="actual-bridge-test-") as data_dir,
        pytest.raises(BridgeError, match="not found"),
        ActualBridge(
            server_url=SERVER_URL,
            password=PASSWORD,
            data_dir=data_dir,
            budget_name="Nonexistent Budget xyzzy",
        ),
    ):
        pass


def test_bridge_import_round_trip(bridge: ActualBridge) -> None:
    account_id = _checking_id(bridge)
    run_tag = f"py-rt-{int(time.time() * 1000)}"
    txs = [
        {
            "date": "2026-02-05",
            "amount": -1234,
            "payee_name": "Coffee Shop",
            "imported_id": f"{run_tag}-1",
            "notes": "morning latte",
        },
        {
            "date": "2026-02-06",
            "amount": -8900,
            "payee_name": "Grocery Store",
            "imported_id": f"{run_tag}-2",
            "notes": "weekly shop",
        },
        {
            "date": "2026-02-07",
            "amount": 250000,
            "payee_name": "Employer",
            "imported_id": f"{run_tag}-3",
            "notes": "salary",
        },
    ]

    result = bridge.import_transactions(account_id, txs)
    assert result.get("errors") == [], f"import errors: {result.get('errors')}"
    assert len(result.get("added") or []) == len(txs), result

    fetched = bridge.get_transactions(account_id, "2026-02-01", "2026-02-28")
    mine = [
        t for t in fetched if (t.get("imported_id") or "").startswith(f"{run_tag}-")
    ]
    assert len(mine) == len(txs), f"expected {len(txs)} round-tripped, got {len(mine)}"

    by_id = {t["imported_id"]: t for t in mine}
    for source in txs:
        match = by_id.get(source["imported_id"])
        assert match is not None, f"missing imported_id {source['imported_id']}"
        assert match["amount"] == source["amount"]
        assert match["date"] == source["date"]
        assert match["notes"] == source["notes"]


def test_bridge_get_account_balance(bridge: ActualBridge) -> None:
    account_id = _checking_id(bridge)
    balance = bridge.get_account_balance(account_id)
    assert isinstance(balance, int)

    cutoff_balance = bridge.get_account_balance(account_id, cutoff_date="2026-02-01")
    assert isinstance(cutoff_balance, int)


def test_bridge_get_categories(bridge: ActualBridge) -> None:
    cats = bridge.get_categories()
    assert isinstance(cats, list)
    # A fresh bootstrap-created budget ships with default categories.
    assert len(cats) > 0, "expected default categories on a fresh budget"


def test_bridge_sync_is_idempotent(bridge: ActualBridge) -> None:
    bridge.sync()
    bridge.sync()  # back-to-back should be fine
