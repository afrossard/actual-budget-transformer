"""Integration tests for --format flag and CAMT.053 output."""

import os

import numpy as np
import pandas as pd

from actual_budget_transformer.main import process_single_file
from actual_budget_transformer.processors.camt053_parser import parse_camt053
from actual_budget_transformer.processors.camt053_processor import Camt053Processor
from actual_budget_transformer.writers.camt053_writer import Camt053Writer
from actual_budget_transformer.writers.csv_writer import CsvWriter
from tests.conftest import SINGLE_DEBIT

UBS_CARDS_FIXTURE = os.path.join(os.path.dirname(__file__), "data", "ubs_cards_1.csv")


def test_format_csv_produces_only_csv(tmp_path):
    process_single_file(SINGLE_DEBIT, str(tmp_path), "csv")
    assert list(tmp_path.glob("*.csv"))
    assert not list(tmp_path.glob("*.xml"))


def test_format_camt053_produces_only_xml(tmp_path):
    process_single_file(SINGLE_DEBIT, str(tmp_path), "camt053")
    assert list(tmp_path.glob("*.xml"))
    assert not list(tmp_path.glob("*.csv"))


def test_format_both_produces_csv_and_xml(tmp_path):
    process_single_file(SINGLE_DEBIT, str(tmp_path), "both")
    assert list(tmp_path.glob("*.csv"))
    assert list(tmp_path.glob("*.xml"))


def test_default_format_is_csv(tmp_path):
    process_single_file(SINGLE_DEBIT, str(tmp_path))
    assert list(tmp_path.glob("*.csv"))
    assert not list(tmp_path.glob("*.xml"))


def test_camt053_output_is_valid(tmp_path):
    """Written XML passes can_process and round-trips through the parser."""
    process_single_file(SINGLE_DEBIT, str(tmp_path), "camt053")
    xml_files = list(tmp_path.glob("*.xml"))
    assert len(xml_files) == 1

    xml_path = str(xml_files[0])
    assert Camt053Processor.can_process(xml_path)

    iban, entries = parse_camt053(xml_path)
    assert iban == "CH9DDDC4D8456C5AFFACD"
    assert len(entries) == 1


def test_camt053_output_from_csv_input(tmp_path):
    """CSV-sourced transactions can be written as CAMT.053."""
    process_single_file(UBS_CARDS_FIXTURE, str(tmp_path), "camt053")
    xml_files = list(tmp_path.glob("*.xml"))
    assert len(xml_files) > 0

    for xml_path in xml_files:
        assert Camt053Processor.can_process(str(xml_path))
        _, entries = parse_camt053(str(xml_path))
        assert len(entries) > 0


def test_camt053_output_preserves_reference(tmp_path):
    """AcctSvcrRef round-trips through write and re-parse."""
    process_single_file(SINGLE_DEBIT, str(tmp_path), "camt053")
    xml_files = list(tmp_path.glob("*.xml"))
    _, entries = parse_camt053(str(xml_files[0]))
    assert entries[0]["reference"] != ""


def test_camt053_writer_splits_by_month(tmp_path):
    """Two months of data produce two XML files."""
    df = pd.DataFrame(
        {
            "transaction_date": [
                pd.Timestamp("2025-01-15"),
                pd.Timestamp("2025-02-20"),
            ],
            "payee": ["A", "B"],
            "notes": ["n1", "n2"],
            "debit": [10.0, 20.0],
            "credit": [np.nan, np.nan],
            "reference": ["R1", "R2"],
        }
    )
    writer = Camt053Writer("CH0000000000")
    writer.save_monthly(df, str(tmp_path), "test")
    xml_files = sorted(f.name for f in tmp_path.glob("*.xml"))
    assert xml_files == ["202501_test.xml", "202502_test.xml"]


def test_csv_writer_splits_by_month(tmp_path):
    """Two months of data produce two CSV files."""
    df = pd.DataFrame(
        {
            "transaction_date": [
                pd.Timestamp("2025-01-15"),
                pd.Timestamp("2025-02-20"),
            ],
            "payee": ["A", "B"],
            "notes": ["n1", "n2"],
            "debit": [10.0, 20.0],
            "credit": [np.nan, np.nan],
            "reference": ["R1", "R2"],
        }
    )
    writer = CsvWriter()
    writer.save_monthly(df, str(tmp_path), "test")
    csv_files = sorted(f.name for f in tmp_path.glob("*.csv"))
    assert csv_files == ["202501_test.csv", "202502_test.csv"]


def test_camt053_writer_dedup_same_data_twice(tmp_path):
    """Processing the same data twice should not create duplicates."""
    df = pd.DataFrame(
        {
            "transaction_date": [pd.Timestamp("2025-01-15")],
            "payee": ["A"],
            "notes": ["n1"],
            "debit": [10.0],
            "credit": [np.nan],
            "reference": ["REF-1"],
        }
    )
    writer = Camt053Writer("CH0000000000")
    writer.save_monthly(df, str(tmp_path), "test")
    writer.save_monthly(df, str(tmp_path), "test")

    _, entries = parse_camt053(str(tmp_path / "202501_test.xml"))
    assert len(entries) == 1


def test_camt053_writer_dedup_merges_new(tmp_path):
    """New transactions are added to existing file."""
    df1 = pd.DataFrame(
        {
            "transaction_date": [pd.Timestamp("2025-01-10")],
            "payee": ["A"],
            "notes": ["n1"],
            "debit": [10.0],
            "credit": [np.nan],
            "reference": ["REF-1"],
        }
    )
    df2 = pd.DataFrame(
        {
            "transaction_date": [
                pd.Timestamp("2025-01-10"),
                pd.Timestamp("2025-01-20"),
            ],
            "payee": ["A", "B"],
            "notes": ["n1", "n2"],
            "debit": [10.0, 20.0],
            "credit": [np.nan, np.nan],
            "reference": ["REF-1", "REF-2"],
        }
    )
    writer = Camt053Writer("CH0000000000")
    writer.save_monthly(df1, str(tmp_path), "test")
    writer.save_monthly(df2, str(tmp_path), "test")

    _, entries = parse_camt053(str(tmp_path / "202501_test.xml"))
    assert len(entries) == 2


def test_csv_writer_dedup_same_data_twice(tmp_path):
    """Processing the same data twice should not create duplicates."""
    df = pd.DataFrame(
        {
            "transaction_date": [pd.Timestamp("2025-01-15")],
            "payee": ["A"],
            "notes": ["n1"],
            "debit": [10.0],
            "credit": [np.nan],
            "reference": ["REF-1"],
        }
    )
    writer = CsvWriter()
    writer.save_monthly(df, str(tmp_path), "test")
    writer.save_monthly(df, str(tmp_path), "test")

    result = pd.read_csv(tmp_path / "202501_test.csv")
    assert len(result) == 1
