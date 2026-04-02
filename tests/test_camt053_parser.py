import datetime

import pytest

from actual_budget_transformer.processors.camt053_parser import parse_camt053
from tests.conftest import (
    MULTI_ENTRY,
    NO_ENTRIES,
    SINGLE_CREDIT,
    SINGLE_DEBIT,
    VALDT_DIFFERS,
)


def test_single_debit_entry():
    iban, entries = parse_camt053(SINGLE_DEBIT)
    assert iban == "CH9DDDC4D8456C5AFFACD"
    assert len(entries) == 1
    entry = entries[0]
    assert entry["direction"] == "DBIT"
    assert entry["amount"] == pytest.approx(21.5)
    assert entry["date"] == datetime.date(2020, 2, 11)


def test_single_credit_entry():
    iban, entries = parse_camt053(SINGLE_CREDIT)
    assert iban == "CH1E021EA3AA5468CA95B"
    assert len(entries) == 1
    entry = entries[0]
    assert entry["direction"] == "CRDT"
    assert entry["amount"] == pytest.approx(80.0)


def test_multi_entry():
    iban, entries = parse_camt053(MULTI_ENTRY)
    assert iban == "CH9DDDC4D8456C5AFFACD"
    assert len(entries) == 2
    assert all(e["direction"] == "DBIT" for e in entries)


def test_no_entries_returns_empty_list():
    iban, entries = parse_camt053(NO_ENTRIES)
    assert iban == "CH1E021EA3AA5468CA95B"
    assert not entries


def test_entry_has_expected_keys():
    _, entries = parse_camt053(SINGLE_DEBIT)
    entry = entries[0]
    expected = {"date", "amount", "direction", "payee", "notes", "reference"}
    assert set(entry.keys()) == expected


def test_payee_is_string():
    _, entries = parse_camt053(SINGLE_DEBIT)
    assert isinstance(entries[0]["payee"], str)


def test_notes_is_string():
    _, entries = parse_camt053(SINGLE_DEBIT)
    assert isinstance(entries[0]["notes"], str)


def test_uses_value_date_when_differs_from_booking_date():
    _, entries = parse_camt053(VALDT_DIFFERS)
    # First entry has ValDt=2020-02-24, BookgDt=2020-02-25
    assert entries[0]["date"] == datetime.date(2020, 2, 24)


def test_reference_is_string():
    _, entries = parse_camt053(SINGLE_DEBIT)
    assert isinstance(entries[0]["reference"], str)
    assert len(entries[0]["reference"]) > 0


def test_non_xml_raises_value_error(tmp_path):
    bad_file = tmp_path / "not_xml.xml"
    bad_file.write_text("this is not xml")
    with pytest.raises(ValueError):
        parse_camt053(str(bad_file))


def test_missing_file_raises_value_error():
    with pytest.raises(ValueError):
        parse_camt053("/nonexistent/path/file.xml")
