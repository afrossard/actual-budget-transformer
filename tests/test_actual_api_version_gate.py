"""Tests for the version-skew gate in the bridge (ADR-007).

The bridge accepts an `ACTUAL_API_VERSION` env var that overrides the value
the gate compares against. We use it to drive the three relevant outcomes
without needing different server versions installed.
"""

from __future__ import annotations

import os
import tempfile
import urllib.error
import urllib.request

import pytest

from actual_budget_transformer.actual_api import ActualBridge, BridgeError

SERVER_URL = os.environ.get("ACTUAL_SERVER_URL", "http://actual-server:5006")
PASSWORD = os.environ.get("ACTUAL_PASSWORD", "test-password")
BUDGET_NAME = os.environ.get("ACTUAL_BUDGET_NAME", "Test Budget")


def _server_reachable() -> bool:
    try:
        urllib.request.urlopen(f"{SERVER_URL}/account/needs-bootstrap", timeout=2)
        return True
    except (urllib.error.URLError, OSError):
        return False


pytestmark = pytest.mark.skipif(
    not _server_reachable(),
    reason=(
        f"Actual server unreachable at {SERVER_URL}; "
        "start with `actual-up` and run `npm run bootstrap`"
    ),
)


def _open(api_version: str) -> ActualBridge:
    data_dir = tempfile.mkdtemp(prefix="actual-bridge-gate-")
    return ActualBridge(
        server_url=SERVER_URL,
        password=PASSWORD,
        data_dir=data_dir,
        budget_name=BUDGET_NAME,
        api_version=api_version,
    )


def test_gate_aborts_when_api_newer_than_server() -> None:
    with pytest.raises(BridgeError, match="newer than server"), _open("99.0.0"):
        pass


def test_gate_proceeds_when_api_older_than_server() -> None:
    # Older API + same/newer server is the safe direction; gate must not block.
    with _open("1.0.0") as b:
        accounts = b.get_accounts()
        assert isinstance(accounts, list)


def test_gate_aborts_on_unparseable_api_version() -> None:
    with pytest.raises(BridgeError, match="cannot parse API version"), _open("garbage"):
        pass
