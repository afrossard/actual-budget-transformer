"""Tests for the CAMT.053 XML builder utility."""

import os
import tempfile

import numpy as np
import pandas as pd
import pytest
from xsdata.formats.dataclass.parsers import XmlParser

from actual_budget_transformer.processors.camt053_parser import parse_camt053
from actual_budget_transformer.writers.camt053_writer import build_camt053_document

IBAN = "CH9300762011623852957"


COLUMNS = ["transaction_date", "payee", "notes", "debit", "credit", "reference"]


def _make_df(rows):
    """Build a DataFrame from (date, payee, notes, debit, credit, ref) tuples."""
    return pd.DataFrame(rows, columns=COLUMNS)


def _roundtrip(xml_str):
    """Write XML to a temp file, parse it back, return (iban, entries)."""
    with tempfile.NamedTemporaryFile(suffix=".xml", mode="w", delete=False) as f:
        f.write(xml_str)
        tmp = f.name
    try:
        return parse_camt053(tmp)
    finally:
        os.unlink(tmp)


class TestBuildCamt053Document:
    def test_output_is_valid_xml(self):
        df = _make_df(
            [
                (pd.Timestamp("2025-01-15"), "Migros", "Groceries", 42.50, np.nan, ""),
            ]
        )
        xml = build_camt053_document(df, IBAN)

        from pyiso20022.camt.camt_053_001_08.camt_053_001_08 import Document

        parser = XmlParser()
        doc = parser.from_string(xml, Document)
        assert doc.bk_to_cstmr_stmt is not None

    def test_output_passes_iso20022_validation(self):
        df = _make_df(
            [
                (
                    pd.Timestamp("2025-01-15"),
                    "Migros",
                    "Groceries",
                    42.50,
                    np.nan,
                    "R1",
                ),
                (pd.Timestamp("2025-01-16"), "Coop", np.nan, np.nan, 20.0, "R2"),
            ]
        )
        xml = build_camt053_document(df, IBAN)

        from pyiso20022.camt.camt_053_001_08.camt_053_001_08 import Document
        from pyiso20022.tools.validation import validate_message

        parser = XmlParser()
        doc = parser.from_string(xml, Document)
        result = validate_message(doc)
        assert result.is_valid, [f"{e.field_name}: {e.message}" for e in result.errors]
        assert len(doc.bk_to_cstmr_stmt.stmt) == 1

    def test_debit_entry_serialised_correctly(self):
        df = _make_df(
            [
                (
                    pd.Timestamp("2025-03-10"),
                    "Shop",
                    "Some notes",
                    99.95,
                    np.nan,
                    "REF-001",
                ),
            ]
        )
        iban, entries = _roundtrip(build_camt053_document(df, IBAN))

        assert iban == IBAN
        assert len(entries) == 1
        assert entries[0]["direction"] == "DBIT"
        assert entries[0]["amount"] == pytest.approx(99.95)
        assert entries[0]["date"].isoformat() == "2025-03-10"
        assert entries[0]["payee"] == "Shop"
        assert entries[0]["notes"] == "Some notes"

    def test_credit_entry_serialised_correctly(self):
        df = _make_df(
            [
                (
                    pd.Timestamp("2025-06-01"),
                    "Employer",
                    "Salary",
                    np.nan,
                    5000.00,
                    "REF-002",
                ),
            ]
        )
        _, entries = _roundtrip(build_camt053_document(df, IBAN))

        assert len(entries) == 1
        assert entries[0]["direction"] == "CRDT"
        assert entries[0]["amount"] == pytest.approx(5000.00)
        assert entries[0]["payee"] == "Employer"

    def test_multiple_entries_roundtrip(self):
        df = _make_df(
            [
                (pd.Timestamp("2025-01-05"), "A", "note a", 10.00, np.nan, "R1"),
                (pd.Timestamp("2025-01-06"), "B", "note b", np.nan, 20.00, "R2"),
                (pd.Timestamp("2025-01-07"), "C", "note c", 30.00, np.nan, "R3"),
            ]
        )
        _, entries = _roundtrip(build_camt053_document(df, IBAN))

        assert len(entries) == 3
        assert [e["direction"] for e in entries] == ["DBIT", "CRDT", "DBIT"]
        assert [e["amount"] for e in entries] == [
            pytest.approx(10.0),
            pytest.approx(20.0),
            pytest.approx(30.0),
        ]

    def test_empty_dataframe_produces_valid_xml_with_zero_entries(self):
        df = _make_df([])
        xml = build_camt053_document(df, IBAN)
        iban, entries = _roundtrip(xml)

        assert iban == IBAN
        assert len(entries) == 0

    def test_empty_payee_roundtrips(self):
        df = _make_df(
            [
                (pd.Timestamp("2025-02-01"), "", "Wire transfer", 100.00, np.nan, "R4"),
            ]
        )
        _, entries = _roundtrip(build_camt053_document(df, IBAN))

        assert len(entries) == 1
        assert entries[0]["payee"] == ""

    def test_empty_notes_roundtrips(self):
        df = _make_df([(pd.Timestamp("2025-02-01"), "Shop", "", 50.00, np.nan, "")])
        _, entries = _roundtrip(build_camt053_document(df, IBAN))

        assert len(entries) == 1
        assert entries[0]["notes"] == ""

    def test_currency_parameter(self):
        df = _make_df([(pd.Timestamp("2025-01-01"), "Test", "n", 10.00, np.nan, "")])
        xml = build_camt053_document(df, IBAN, currency="EUR")
        assert "EUR" in xml

    def test_iban_embedded_in_output(self):
        df = _make_df([(pd.Timestamp("2025-01-01"), "X", "n", 1.00, np.nan, "")])
        xml = build_camt053_document(df, IBAN)
        assert IBAN in xml

    def test_booking_date_matches_transaction_date(self):
        df = _make_df([(pd.Timestamp("2025-07-22"), "P", "n", 5.00, np.nan, "")])
        _, entries = _roundtrip(build_camt053_document(df, IBAN))
        assert entries[0]["date"].isoformat() == "2025-07-22"

    def test_reference_roundtrips(self):
        df = _make_df(
            [
                (pd.Timestamp("2025-01-01"), "X", "n", 10.00, np.nan, "MY-REF-123"),
            ]
        )
        _, entries = _roundtrip(build_camt053_document(df, IBAN))
        assert entries[0]["reference"] == "MY-REF-123"

    def test_empty_reference_roundtrips(self):
        df = _make_df(
            [
                (pd.Timestamp("2025-01-01"), "X", "n", 10.00, np.nan, ""),
            ]
        )
        _, entries = _roundtrip(build_camt053_document(df, IBAN))
        assert entries[0]["reference"] == ""

    def test_reference_appears_in_xml(self):
        df = _make_df(
            [
                (pd.Timestamp("2025-01-01"), "X", "n", 10.00, np.nan, "UNIQUE-REF"),
            ]
        )
        xml = build_camt053_document(df, IBAN)
        assert "UNIQUE-REF" in xml
