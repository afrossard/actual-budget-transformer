#!/usr/bin/env python3
"""Anonymize a UBS account CSV transaction file for use as test data.

Replaces sensitive fields (account number, IBAN, transaction reference,
and description/notes columns) with deterministic fakes while preserving
dates, amounts, balances, currencies, and CSV structure.

Usage:
    python scripts/anonymize_ubs_csv.py input.csv output.csv

The salt is read from the ``ANONYMIZE_SALT`` environment variable, or prompted
interactively (not echoed). To set it without it appearing in shell history:

    read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
"""

import argparse
import csv
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _anonymize_utils import (  # pylint: disable=wrong-import-position
    _hash8,
    fake_account,
    fake_iban,
    fake_text,
    get_salt,
    shift_dates_iso,
)

# Header rows (1-based) and the column index (0-based) holding the sensitive value
ACCOUNT_ROW = 1  # "Numéro de compte:"
IBAN_ROW = 2  # "IBAN:"

# Transaction column indices (0-based), after the blank line + header row
TRANSACTION_DATE_COL = 0  # Date de transaction
BOOKING_DATE_COL = 2  # Date de comptabilisation
VALUE_DATE_COL = 3  # Date de valeur
TRANSACTION_REF_COL = 9  # N° de transaction
DESCRIPTION1_COL = 10  # Description1 (payee)
DESCRIPTION2_COL = 11  # Description2
DESCRIPTION3_COL = 12  # Description3
FOOTNOTES_COL = 13  # Notes de bas de page

HEADER_ROWS = 8


def fake_ref(original: str, salt: str) -> str:
    """Return a deterministic fake transaction reference."""
    return f"REF-{_hash8(original, salt)}"


def _anonymize_col(cols: list, index: int, fn, salt: str) -> None:
    """Apply fn to cols[index] in place if the value is non-empty."""
    if index < len(cols) and cols[index].strip():
        cols[index] = fn(cols[index].strip(), salt)


def _parse_row(line: str) -> list[str]:
    """Parse a semicolon-delimited line respecting quoted fields."""
    return next(csv.reader(io.StringIO(line), delimiter=";"))


def _write_row(cols: list[str]) -> str:
    """Serialise a list of fields back to a semicolon-delimited line."""
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(cols)
    return buf.getvalue()


def anonymize(input_path: Path, output_path: Path, salt: str) -> None:
    """Anonymize sensitive fields in a UBS account CSV file."""
    with open(input_path, "r", encoding="utf-8-sig") as f:
        lines = f.readlines()

    out_lines = []
    for row_number, line in enumerate(lines, start=1):
        stripped = line.rstrip("\n")

        if row_number == ACCOUNT_ROW:
            cols = _parse_row(stripped)
            if len(cols) > 1 and cols[1].strip():
                cols[1] = fake_account(cols[1].strip(), salt)
            out_lines.append(_write_row(cols))
            continue

        if row_number == IBAN_ROW:
            cols = _parse_row(stripped)
            if len(cols) > 1 and cols[1].strip():
                cols[1] = fake_iban(cols[1].strip(), salt)
            out_lines.append(_write_row(cols))
            continue

        # Rows 3–HEADER_ROWS: shift any dates, keep everything else as-is
        if row_number <= HEADER_ROWS:
            out_lines.append(shift_dates_iso(line, salt))
            continue

        # Blank line + column header row: keep as-is
        if row_number <= HEADER_ROWS + 2:
            out_lines.append(line)
            continue

        # Transaction rows
        if not stripped:
            out_lines.append(line)
            continue

        cols = _parse_row(stripped)
        _anonymize_col(cols, TRANSACTION_DATE_COL, shift_dates_iso, salt)
        _anonymize_col(cols, BOOKING_DATE_COL, shift_dates_iso, salt)
        _anonymize_col(cols, VALUE_DATE_COL, shift_dates_iso, salt)
        _anonymize_col(cols, TRANSACTION_REF_COL, fake_ref, salt)
        _anonymize_col(cols, DESCRIPTION1_COL, fake_text, salt)
        _anonymize_col(cols, DESCRIPTION2_COL, fake_text, salt)
        _anonymize_col(cols, DESCRIPTION3_COL, fake_text, salt)
        _anonymize_col(cols, FOOTNOTES_COL, fake_text, salt)
        out_lines.append(_write_row(cols))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8-sig") as f:
        f.writelines(out_lines)

    print(f"Anonymized: {input_path} -> {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    anonymize(args.input, args.output, get_salt())
