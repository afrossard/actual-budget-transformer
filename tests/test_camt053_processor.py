import os

import pandas as pd
import pytest

from actual_budget_transformer.processors.base_processor import ProcessingResult
from actual_budget_transformer.processors.camt053_processor import Camt053Processor
from tests.conftest import (
    DATA_DIR,
    MULTI_ENTRY,
    NO_ENTRIES,
    SINGLE_CREDIT,
    SINGLE_DEBIT,
    XML_FIXTURES,
)

CSV_FIXTURE = os.path.join(DATA_DIR, "ubs_valid.csv")


def test_can_process_all_xml_fixtures():
    assert XML_FIXTURES, "No XML fixtures found"
    for path in XML_FIXTURES:
        assert Camt053Processor.can_process(path), f"Expected True for {path}"


def test_can_process_returns_false_for_csv():
    assert not Camt053Processor.can_process(CSV_FIXTURE)


def test_can_process_returns_false_for_non_camt_xml(tmp_path):
    f = tmp_path / "other.xml"
    f.write_text("<root/>")
    assert not Camt053Processor.can_process(str(f))


def test_can_process_returns_false_for_malformed_xml(tmp_path):
    f = tmp_path / "bad.xml"
    f.write_text("<unclosed")
    assert not Camt053Processor.can_process(str(f))


def test_can_process_returns_false_for_nonexistent_file():
    assert not Camt053Processor.can_process("/nonexistent/path/file.xml")


def test_process_single_debit():
    result = Camt053Processor().process(SINGLE_DEBIT)
    df = result.data
    assert len(df) == 1
    assert list(df.columns) == ProcessingResult.COLUMNS
    assert pytest.approx(df.iloc[0]["debit"]) == 21.5
    assert pd.isna(df.iloc[0]["credit"])


def test_process_single_credit():
    result = Camt053Processor().process(SINGLE_CREDIT)
    df = result.data
    assert len(df) == 1
    assert pytest.approx(df.iloc[0]["credit"]) == 80.0
    assert pd.isna(df.iloc[0]["debit"])


def test_process_multi_entry():
    result = Camt053Processor().process(MULTI_ENTRY)
    assert len(result.data) == 2


def test_process_zero_entries_returns_empty_dataframe():
    result = Camt053Processor().process(NO_ENTRIES)
    df = result.data
    assert len(df) == 0
    assert list(df.columns) == ProcessingResult.COLUMNS


def test_process_output_prefix_uses_friendly_name():
    # CH9DDDC4D8456C5AFFACD is mapped to 'test_account' in test_config.yml
    result = Camt053Processor().process(SINGLE_DEBIT)
    assert result.output_prefix == "test_account"


def test_process_output_prefix_falls_back_to_iban():
    # CH1E021EA3AA5468CA95B has no mapping in test_config.yml
    result = Camt053Processor().process(SINGLE_CREDIT)
    assert result.output_prefix == "CH1E021EA3AA5468CA95B"


def test_process_transaction_date_is_timestamp():
    result = Camt053Processor().process(SINGLE_DEBIT)
    assert isinstance(result.data.iloc[0]["transaction_date"], pd.Timestamp)


def test_process_includes_reference_column():
    result = Camt053Processor().process(SINGLE_DEBIT)
    assert "reference" in result.data.columns
    assert result.data.iloc[0]["reference"] != ""


def test_processing_result_rejects_missing_columns():
    df = pd.DataFrame({"transaction_date": [], "payee": []})
    with pytest.raises(ValueError, match="missing columns"):
        ProcessingResult(data=df, output_prefix="test")
