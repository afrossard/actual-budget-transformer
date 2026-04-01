import os

import pandas as pd
import pytest

from actual_budget_transformer.factory import get_processor_for_file
from actual_budget_transformer.main import process_single_file
from actual_budget_transformer.processors.camt053_processor import Camt053Processor
from actual_budget_transformer.processors.ubs_cards_csv_transaction_processor import (
    UBSCardsCSVTransactionProcessor,
)
from actual_budget_transformer.processors.ubs_csv_transaction_processor import (
    UBSCSVTransactionProcessor,
)
from tests.conftest import DATA_DIR, MULTI_ENTRY, SINGLE_DEBIT, XML_FIXTURES

UBS_CSV_FIXTURE = os.path.join(DATA_DIR, "ubs_valid.csv")
UBS_CARDS_FIXTURE = os.path.join(DATA_DIR, "ubs_cards_1.csv")


def test_get_processor_for_xml_returns_camt053():
    for path in XML_FIXTURES:
        assert isinstance(get_processor_for_file(path), Camt053Processor)


def test_get_processor_for_ubs_csv():
    assert isinstance(
        get_processor_for_file(UBS_CSV_FIXTURE), UBSCSVTransactionProcessor
    )


def test_get_processor_for_ubs_cards():
    assert isinstance(
        get_processor_for_file(UBS_CARDS_FIXTURE), UBSCardsCSVTransactionProcessor
    )


def test_get_processor_raises_for_unknown_file(tmp_path):
    f = tmp_path / "unknown.txt"
    f.write_text("nothing")
    with pytest.raises(ValueError):
        get_processor_for_file(str(f))


def test_process_single_file_end_to_end(tmp_path):
    process_single_file(SINGLE_DEBIT, str(tmp_path))
    output_files = list(tmp_path.glob("*.csv"))
    assert len(output_files) == 1


def test_monthly_split_produces_one_file_per_month(tmp_path):
    # ubs_cards_1.csv spans January and February 2020
    process_single_file(UBS_CARDS_FIXTURE, str(tmp_path))
    files = sorted(f.name for f in tmp_path.glob("*.csv"))
    assert files == ["202001_ubs_cards_test_card.csv", "202002_ubs_cards_test_card.csv"]


def test_dedup_same_file_twice(tmp_path):
    # Processing the same file twice should not create duplicates
    process_single_file(SINGLE_DEBIT, str(tmp_path))
    first_df = pd.read_csv(tmp_path / "202002_camt053_test_account.csv")
    process_single_file(SINGLE_DEBIT, str(tmp_path))
    second_df = pd.read_csv(tmp_path / "202002_camt053_test_account.csv")
    assert len(second_df) == len(first_df)


def test_dedup_different_files_same_account(tmp_path):
    # SINGLE_DEBIT and MULTI_ENTRY share the same IBAN and month (Feb 2020)
    # but have distinct transactions — all should appear, with no duplicates
    process_single_file(SINGLE_DEBIT, str(tmp_path))
    process_single_file(MULTI_ENTRY, str(tmp_path))
    df = pd.read_csv(tmp_path / "202002_camt053_test_account.csv")
    assert len(df) == 3  # 1 from SINGLE_DEBIT + 2 from MULTI_ENTRY
    # Process both again — count should stay at 3
    process_single_file(SINGLE_DEBIT, str(tmp_path))
    process_single_file(MULTI_ENTRY, str(tmp_path))
    df = pd.read_csv(tmp_path / "202002_camt053_test_account.csv")
    assert len(df) == 3
