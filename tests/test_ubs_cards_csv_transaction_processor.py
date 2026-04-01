import os

import pandas as pd
import pytest

from actual_budget_transformer.processors.base_processor import ProcessingResult
from actual_budget_transformer.processors.ubs_cards_csv_transaction_processor import (
    UBSCardsCSVTransactionProcessor,
)
from tests.conftest import DATA_DIR

# ubs_cards_1.csv has card number mapped to "test_card" in test_config.yml
VALID_MAPPED = os.path.join(DATA_DIR, "ubs_cards_1.csv")
# ubs_cards_2.csv has an unmapped card number
VALID_UNMAPPED = os.path.join(DATA_DIR, "ubs_cards_2.csv")
CSV_NO_SEP = os.path.join(DATA_DIR, "ubs_valid.csv")


def test_can_process_valid_file():
    assert UBSCardsCSVTransactionProcessor.can_process(VALID_MAPPED) is True


def test_can_process_valid_unmapped_file():
    assert UBSCardsCSVTransactionProcessor.can_process(VALID_UNMAPPED) is True


def test_can_process_returns_false_for_missing_sep_line():
    assert UBSCardsCSVTransactionProcessor.can_process(CSV_NO_SEP) is False


def test_can_process_returns_false_for_non_csv(tmp_path):
    f = tmp_path / "other.xml"
    f.write_text("<root/>")
    assert UBSCardsCSVTransactionProcessor.can_process(str(f)) is False


def test_can_process_returns_false_for_wrong_headers(tmp_path):
    f = tmp_path / "bad.csv"
    f.write_text("sep=;\nCol1;Col2;Col3\nval1;val2;val3\n", encoding="iso-8859-1")
    assert UBSCardsCSVTransactionProcessor.can_process(str(f)) is False


def test_process_returns_correct_columns():
    result = UBSCardsCSVTransactionProcessor().process(VALID_MAPPED)
    assert list(result.data.columns) == ProcessingResult.COLUMNS


def test_process_returns_rows():
    result = UBSCardsCSVTransactionProcessor().process(VALID_MAPPED)
    assert len(result.data) > 0


def test_process_transaction_date_is_timestamp():
    result = UBSCardsCSVTransactionProcessor().process(VALID_MAPPED)
    assert isinstance(result.data.iloc[0]["transaction_date"], pd.Timestamp)


def test_process_output_prefix_uses_friendly_name():
    result = UBSCardsCSVTransactionProcessor().process(VALID_MAPPED)
    assert result.output_prefix == "ubs_cards_test_card"


def test_process_output_prefix_falls_back_to_card_number():
    result = UBSCardsCSVTransactionProcessor().process(VALID_UNMAPPED)
    assert result.output_prefix.startswith("ubs_cards_card_")


def test_process_raises_on_invalid_file(tmp_path):
    f = tmp_path / "bad.csv"
    f.write_text("sep=;\nCol1;Col2\nval1;val2\n", encoding="iso-8859-1")
    with pytest.raises(ValueError):
        UBSCardsCSVTransactionProcessor().process(str(f))


def test_process_debit_row_fields():
    # First data row: 24.02.2020, MERCHANT-57823B77, MERCHANT-9B929026, debit=41
    result = UBSCardsCSVTransactionProcessor().process(VALID_MAPPED)
    row = result.data[
        result.data["transaction_date"] == pd.Timestamp("2020-02-24")
    ].iloc[0]
    assert row["payee"] == "MERCHANT-57823B77"
    assert row["notes"] == "MERCHANT-9B929026"
    assert pytest.approx(row["debit"]) == 41
    assert row["credit"] == 0


def test_process_credit_row_fields():
    # Credit row: 06.01.2020, credit=50
    result = UBSCardsCSVTransactionProcessor().process(VALID_MAPPED)
    df = result.data
    row = df[
        (df["transaction_date"] == pd.Timestamp("2020-01-06")) & (df["credit"] > 0)
    ].iloc[0]
    assert pytest.approx(row["credit"]) == 50
    assert row["debit"] == 0


def test_can_process_returns_false_for_wrong_encoding(tmp_path):
    # A valid-structure file saved as UTF-8 instead of iso-8859-1 should be rejected
    # because accented column names won't match when read as iso-8859-1
    with open(VALID_MAPPED, encoding="iso-8859-1") as fh:
        src = fh.read()
    f = tmp_path / "utf8.csv"
    f.write_text(src, encoding="utf-8")
    assert UBSCardsCSVTransactionProcessor.can_process(str(f)) is False
