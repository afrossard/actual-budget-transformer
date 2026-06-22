"""Python wrapper around the JS API bridge subprocess.

Spawns ``actual_api_bridge.ts`` via the local ``tsx`` binary, sends
newline-delimited JSON commands on stdin, and reads one JSON response per line
from stdout. Lifecycle is tied to a context manager: ``__enter__`` opens the
budget, ``__exit__`` shuts the bridge down cleanly.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger("actual_budget_transformer")

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BRIDGE_SCRIPT = (
    _REPO_ROOT / "src" / "actual_budget_transformer" / "bridge" / "actual_api_bridge.ts"
)
_TSX_BIN = _REPO_ROOT / "node_modules" / ".bin" / "tsx"


class BridgeError(RuntimeError):
    """Raised when the bridge returns an error response or exits unexpectedly."""


class ActualBridge:
    """Context-managed handle on a live `@actual-app/api` connection."""

    def __init__(
        self,
        server_url: str,
        password: str,
        data_dir: str,
        budget_name: str,
        api_version: str | None = None,
    ) -> None:
        self._server_url = server_url
        self._password = password
        self._data_dir = data_dir
        self._budget_name = budget_name
        self._api_version = api_version
        self._proc: subprocess.Popen[str] | None = None
        self._req_id = 0
        self._stderr_thread: threading.Thread | None = None

    def __enter__(self) -> ActualBridge:
        self._spawn()
        try:
            self.send(
                "open",
                server_url=self._server_url,
                password=self._password,
                data_dir=self._data_dir,
                budget_name=self._budget_name,
            )
        except Exception:
            self._terminate()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self._proc and self._proc.poll() is None:
                with contextlib.suppress(BridgeError):
                    self.send("shutdown")
        finally:
            self._terminate()

    def get_accounts(self) -> list[dict[str, Any]]:
        result = self.send("get_accounts")
        if not isinstance(result, list):
            raise BridgeError(
                f"get_accounts: expected list, got {type(result).__name__}"
            )
        return result

    def get_transactions(
        self, account_id: str, start_date: str, end_date: str
    ) -> list[dict[str, Any]]:
        result = self.send(
            "get_transactions",
            account_id=account_id,
            start_date=start_date,
            end_date=end_date,
        )
        if not isinstance(result, list):
            raise BridgeError(
                f"get_transactions: expected list, got {type(result).__name__}"
            )
        return result

    def import_transactions(
        self, account_id: str, transactions: list[dict[str, Any]]
    ) -> dict[str, Any]:
        result = self.send(
            "import_transactions",
            account_id=account_id,
            transactions=transactions,
        )
        if not isinstance(result, dict):
            raise BridgeError(
                f"import_transactions: expected dict, got {type(result).__name__}"
            )
        return result

    def get_account_balance(
        self, account_id: str, cutoff_date: str | None = None
    ) -> int:
        params: dict[str, Any] = {"account_id": account_id}
        if cutoff_date is not None:
            params["cutoff_date"] = cutoff_date
        result = self.send("get_account_balance", **params)
        if not isinstance(result, int):
            raise BridgeError(
                f"get_account_balance: expected int, "
                f"got {type(result).__name__}: {result!r}"
            )
        return result

    def get_categories(self) -> list[dict[str, Any]]:
        result = self.send("get_categories")
        if not isinstance(result, list):
            raise BridgeError(
                f"get_categories: expected list, got {type(result).__name__}"
            )
        return result

    def update_transaction(self, tx_id: str, fields: dict[str, Any]) -> None:
        """Patch an existing transaction (e.g. ``{"reconciled": True}``).

        Backed by the public ``updateTransaction(id, fields)`` API. The write
        is local until the next ``sync()``.
        """
        self.send("update_transaction", id=tx_id, fields=fields)

    def sync(self) -> None:
        self.send("sync")

    def send(self, command: str, **params: Any) -> Any:
        if self._proc is None or self._proc.stdin is None or self._proc.stdout is None:
            raise BridgeError("bridge subprocess not running")
        self._req_id += 1
        req = {"id": self._req_id, "command": command, "params": params}
        try:
            self._proc.stdin.write(json.dumps(req) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise BridgeError(f"failed to send {command!r}: {e}") from e

        line = self._proc.stdout.readline()
        if not line:
            rc = self._proc.poll()
            raise BridgeError(
                f"bridge closed before responding to {command!r} (exit code: {rc})"
            )
        try:
            resp = json.loads(line)
        except json.JSONDecodeError as e:
            raise BridgeError(f"bad JSON from bridge: {e}: {line!r}") from e

        if resp.get("id") != self._req_id:
            raise BridgeError(f"id mismatch: sent {self._req_id}, got {resp.get('id')}")
        if not resp.get("ok"):
            err = resp.get("error") or {}
            raise BridgeError(err.get("message") or "unknown bridge error")
        return resp.get("result")

    def _spawn(self) -> None:
        if not _TSX_BIN.exists():
            raise BridgeError(
                f"tsx not found at {_TSX_BIN}. Run `npm install` in {_REPO_ROOT}."
            )
        if not _BRIDGE_SCRIPT.exists():
            raise BridgeError(f"bridge script missing: {_BRIDGE_SCRIPT}")

        env = os.environ.copy()
        if self._api_version:
            env["ACTUAL_API_VERSION"] = self._api_version

        self._proc = subprocess.Popen(
            [str(_TSX_BIN), str(_BRIDGE_SCRIPT)],
            cwd=str(_REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        for line in self._proc.stderr:
            logger.info("bridge stderr: %s", line.rstrip())

    def _terminate(self) -> None:
        if self._proc is None:
            return
        if self._proc.stdin and not self._proc.stdin.closed:
            with contextlib.suppress(OSError):
                self._proc.stdin.close()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()
        if self._stderr_thread:
            self._stderr_thread.join(timeout=1)
        self._proc = None
