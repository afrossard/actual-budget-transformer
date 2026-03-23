#!/usr/bin/env python3
"""Anonymize a UBS account CSV transaction file for use as test data.

Replaces sensitive fields (account number, IBAN, transaction reference,
and description/notes columns) with deterministic fakes while preserving
dates, amounts, balances, currencies, and CSV structure.

Usage:
    python scripts/anonymize_ubs_csv.py input.csv output.csv
"""

import csv
import hashlib
import io
import sys
from pathlib import Path

# Header rows (1-based) and the column index (0-based) holding the sensitive value
ACCOUNT_ROW = 1  # "Numéro de compte:"
IBAN_ROW = 2  # "IBAN:"

# Transaction column indices (0-based), after the blank line + header row
TRANSACTION_REF_COL = 9  # N° de transaction
DESCRIPTION1_COL = 10  # Description1 (payee)
DESCRIPTION2_COL = 11  # Description2
DESCRIPTION3_COL = 12  # Description3
FOOTNOTES_COL = 13  # Notes de bas de page

HEADER_ROWS = 8


def _hash8(value: str) -> str:
    """Return an 8-character uppercase hex digest of the value."""
    return hashlib.sha256(value.encode()).hexdigest()[:8].upper()


def fake_account(original: str) -> str:
    """Return a deterministic fake account number."""
    return f"ANON-ACCT-{_hash8(original)}"


def fake_iban(original: str) -> str:
    """Keep country code and length, replace the rest deterministically."""
    clean = original.replace(" ", "")
    country = clean[:2] if len(clean) >= 2 else "XX"
    digits = (hashlib.sha256(clean.encode()).hexdigest() * 2)[: len(clean) - 2]
    digits = "".join(c for c in digits if c.isalnum()).upper()
    fake = (country + digits)[: len(clean)]
    # Re-insert spaces at original positions
    result, j = [], 0
    for ch in original:
        if ch == " ":
            result.append(" ")
        else:
            result.append(fake[j])
            j += 1
    return "".join(result)


def fake_text(original: str) -> str:
    """Return a deterministic redacted placeholder."""
    return f"REDACTED-{_hash8(original)}"


def fake_ref(original: str) -> str:
    """Return a deterministic fake transaction reference."""
    return f"REF-{_hash8(original)}"


def _anonymize_col(cols: list, index: int, fn) -> None:
    """Apply fn to cols[index] in place if the value is non-empty."""
    if index < len(cols) and cols[index].strip():
        cols[index] = fn(cols[index].strip())


def _parse_row(line: str) -> list[str]:
    """Parse a semicolon-delimited line respecting quoted fields."""
    return next(csv.reader(io.StringIO(line), delimiter=";"))


def _write_row(cols: list[str]) -> str:
    """Serialise a list of fields back to a semicolon-delimited line."""
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(cols)
    return buf.getvalue()


def anonymize(input_path: Path, output_path: Path) -> None:
    """Anonymize sensitive fields in a UBS account CSV file."""
    with open(input_path, "r", encoding="utf-8-sig") as f:
        lines = f.readlines()

    out_lines = []
    for row_number, line in enumerate(lines, start=1):
        stripped = line.rstrip("\n")

        if row_number == ACCOUNT_ROW:
            cols = _parse_row(stripped)
            if len(cols) > 1 and cols[1].strip():
                cols[1] = fake_account(cols[1].strip())
            out_lines.append(_write_row(cols))
            continue

        if row_number == IBAN_ROW:
            cols = _parse_row(stripped)
            if len(cols) > 1 and cols[1].strip():
                cols[1] = fake_iban(cols[1].strip())
            out_lines.append(_write_row(cols))
            continue

        # Rows 3–HEADER_ROWS and the blank line + column header row: keep as-is
        if row_number <= HEADER_ROWS + 2:
            out_lines.append(line)
            continue

        # Transaction rows
        if not stripped:
            out_lines.append(line)
            continue

        cols = _parse_row(stripped)
        _anonymize_col(cols, TRANSACTION_REF_COL, fake_ref)
        _anonymize_col(cols, DESCRIPTION1_COL, fake_text)
        _anonymize_col(cols, DESCRIPTION2_COL, fake_text)
        _anonymize_col(cols, DESCRIPTION3_COL, fake_text)
        _anonymize_col(cols, FOOTNOTES_COL, fake_text)
        out_lines.append(_write_row(cols))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8-sig") as f:
        f.writelines(out_lines)

    print(f"Anonymized: {input_path} -> {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.csv> <output.csv>")
        sys.exit(1)
    anonymize(Path(sys.argv[1]), Path(sys.argv[2]))
