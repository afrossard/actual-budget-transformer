"""Offline unit tests for the conservative-automation logic in
``actual_budget_importer``. The orchestrator (``ActualBudgetImporter``) needs
a live bridge — those go in the integration suite. These tests hit only the
pure helpers."""

from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from actual_budget_transformer.writers.actual_budget_importer import (
    BalanceCheckpoint,
    _coerce_amount_cents,
    _stable_id,
    circuit_breaker_trips,
    classify_transactions,
    compute_batches,
    df_to_actual_txs,
    resolve_actual_config,
)

# -- amount conversion ------------------------------------------------------


def test_credit_only_is_positive_cents():
    assert _coerce_amount_cents(debit=None, credit=120.30) == 12030


def test_debit_only_is_negative_cents():
    assert _coerce_amount_cents(debit=89.00, credit=None) == -8900


def test_nan_treated_as_zero():
    assert _coerce_amount_cents(debit=float("nan"), credit=12.50) == 1250
    assert _coerce_amount_cents(debit=12.50, credit=float("nan")) == -1250


def test_both_zero_is_zero():
    assert _coerce_amount_cents(debit=0, credit=0) == 0


def test_amount_rounds_half_to_even():
    # 0.005 -> 0 cents under banker's rounding (round half to even)
    assert _coerce_amount_cents(debit=None, credit=0.005) == 0
    # 0.015 -> 2 cents under banker's rounding
    assert _coerce_amount_cents(debit=None, credit=0.015) == 2


# -- df_to_actual_txs --------------------------------------------------------


def test_df_to_actual_txs_uses_reference_as_imported_id():
    df = pd.DataFrame(
        [
            {
                "transaction_date": pd.Timestamp("2026-02-05"),
                "payee": "Coffee",
                "notes": "morning",
                "debit": 4.50,
                "credit": float("nan"),
                "reference": "BANK-REF-1",
            }
        ]
    )
    [tx] = df_to_actual_txs(df)
    assert tx["date"] == "2026-02-05"
    assert tx["amount"] == -450
    assert tx["payee_name"] == "Coffee"
    assert tx["notes"] == "morning"
    assert tx["imported_id"] == "BANK-REF-1"


def test_df_to_actual_txs_falls_back_to_stable_id_when_reference_empty():
    df = pd.DataFrame(
        [
            {
                "transaction_date": pd.Timestamp("2026-02-05"),
                "payee": "Coffee",
                "notes": "morning",
                "debit": 4.50,
                "credit": float("nan"),
                "reference": "",
            }
        ]
    )
    [tx] = df_to_actual_txs(df)
    expected = _stable_id("2026-02-05", -450, "Coffee", "morning")
    assert tx["imported_id"] == expected
    # Determinism: same inputs → same id on a re-run.
    [tx2] = df_to_actual_txs(df)
    assert tx["imported_id"] == tx2["imported_id"]


# -- compute_batches ---------------------------------------------------------


def test_batches_pure_monthly_when_no_checkpoints():
    dates = [dt.date(2026, 1, 5), dt.date(2026, 1, 28), dt.date(2026, 2, 3)]
    batches = compute_batches(dates, [])
    boundaries = [b.boundary for b in batches]
    assert boundaries == [dt.date(2026, 1, 31), dt.date(2026, 2, 28)]
    assert all(b.checkpoint is None for b in batches)


def test_checkpoint_inside_a_month_adds_an_extra_boundary():
    dates = [dt.date(2026, 1, 5), dt.date(2026, 1, 28)]
    cp = BalanceCheckpoint(date=dt.date(2026, 1, 19), amount=100.0)
    batches = compute_batches(dates, [cp])
    assert [b.boundary for b in batches] == [
        dt.date(2026, 1, 19),
        dt.date(2026, 1, 31),
    ]
    assert batches[0].checkpoint is cp
    assert batches[1].checkpoint is None


def test_checkpoint_on_month_end_deduplicates_boundary():
    dates = [dt.date(2026, 1, 5), dt.date(2026, 1, 31)]
    cp = BalanceCheckpoint(date=dt.date(2026, 1, 31), amount=42.0)
    batches = compute_batches(dates, [cp])
    assert len(batches) == 1
    assert batches[0].boundary == dt.date(2026, 1, 31)
    assert batches[0].checkpoint is cp


def test_no_dates_no_batches():
    assert compute_batches([], []) == []


def test_batches_sorted_ascending():
    dates = [dt.date(2026, 3, 5), dt.date(2026, 1, 5)]
    batches = compute_batches(dates, [])
    boundaries = [b.boundary for b in batches]
    assert boundaries == sorted(boundaries)


# -- classify_transactions ---------------------------------------------------


def _src(date: str, amount: int, imported_id: str = "") -> dict:
    return {
        "date": date,
        "amount": amount,
        "imported_id": imported_id or f"new-{date}-{amount}",
        "payee_name": "x",
        "notes": "",
    }


def _existing(date: str, amount: int, imported_id: str = "") -> dict:
    return {"date": date, "amount": amount, "imported_id": imported_id}


def test_classify_skip_when_imported_id_already_in_actual():
    src = [_src("2026-02-05", -450, imported_id="REF-1")]
    existing = [_existing("2026-02-05", -450, imported_id="REF-1")]
    clean, suspicious, skipped = classify_transactions(src, existing)
    assert (clean, suspicious) == ([], [])
    assert skipped == src


def test_classify_clean_when_no_existing_amount_match():
    src = [_src("2026-02-05", -450)]
    existing = [_existing("2026-02-05", -999)]  # different amount
    clean, suspicious, skipped = classify_transactions(src, existing)
    assert clean == src
    assert suspicious == []
    assert skipped == []


def test_classify_suspicious_when_amount_match_within_one_day():
    src = [_src("2026-02-05", -450)]
    existing = [_existing("2026-02-06", -450)]  # 1 day off, same amount, different id
    clean, suspicious, skipped = classify_transactions(src, existing)
    assert suspicious == src
    assert clean == []


def test_classify_clean_when_amount_match_more_than_one_day_off():
    src = [_src("2026-02-05", -450)]
    existing = [_existing("2026-02-08", -450)]  # 3 days off
    clean, suspicious, skipped = classify_transactions(src, existing)
    assert clean == src
    assert suspicious == []


def test_classify_groups_share_fate():
    """Conservative dedup: when N source tx share amount/date and at least one
    matches an existing tx, *all* N flag for review (ADR-006)."""
    src = [_src("2026-02-05", -1250) for _ in range(3)]
    existing = [_existing("2026-02-05", -1250)]
    clean, suspicious, skipped = classify_transactions(src, existing)
    assert len(suspicious) == 3
    assert clean == []


# -- circuit breaker --------------------------------------------------------


def test_circuit_breaker_trips_strictly_above_threshold():
    assert circuit_breaker_trips(suspicious_count=6, threshold=5) is True
    assert circuit_breaker_trips(suspicious_count=5, threshold=5) is False
    assert circuit_breaker_trips(suspicious_count=0, threshold=5) is False


# -- config resolution ------------------------------------------------------


def test_resolve_actual_config_env_overrides_yaml():
    cfg = {
        "actual_budget": {
            "server_url": "http://yaml-host:5006",
            "password": "yaml-pw",
            "budget_name": "yaml-budget",
        }
    }
    env = {
        "ACTUAL_BUDGET_URL": "http://env-host:5006",
        "ACTUAL_BUDGET_PASSWORD": "env-pw",
        "ACTUAL_BUDGET_FILE": "env-budget",
    }
    out = resolve_actual_config(cfg, env)
    assert out["server_url"] == "http://env-host:5006"
    assert out["password"] == "env-pw"
    assert out["budget_name"] == "env-budget"


def test_resolve_actual_config_defaults():
    cfg = {
        "actual_budget": {
            "server_url": "http://h:5006",
            "password": "pw",
            "budget_name": "b",
        }
    }
    out = resolve_actual_config(cfg, env={})
    assert out["review_category"] == "To Review"
    assert out["suspicious_threshold"] == 5


def test_resolve_actual_config_raises_on_missing():
    with pytest.raises(ValueError, match="incomplete"):
        resolve_actual_config({"actual_budget": {}}, env={})


def test_resolve_actual_config_picks_up_yaml_only():
    cfg = {
        "actual_budget": {
            "server_url": "http://h:5006",
            "password": "pw",
            "budget_name": "b",
            "review_category": "Needs Review",
            "suspicious_threshold": 10,
        }
    }
    out = resolve_actual_config(cfg, env={})
    assert out["review_category"] == "Needs Review"
    assert out["suspicious_threshold"] == 10
