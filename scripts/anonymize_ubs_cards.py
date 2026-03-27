#!/usr/bin/env python3
"""Anonymize a UBS cards CSV file for use as test data.

Replaces sensitive fields (account number, card number, cardholder name,
merchant names) with deterministic fakes while preserving dates, amounts,
currencies, and CSV structure.

Usage:
    python scripts/anonymize_ubs_cards.py input.csv output.csv

The salt is read from the ``ANONYMIZE_SALT`` environment variable, or prompted
interactively (not echoed). To set it without it appearing in shell history:

    read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
"""

import argparse
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _anonymize_utils import (  # pylint: disable=wrong-import-position
    _hash8,
    fake_account,
    fake_name,
    get_salt,
    shift_dates_ch,
)


def fake_card_number(original: str, salt: str) -> str:
    """Replace card digits deterministically, preserving length."""
    digits = hashlib.sha256(f"{salt}:{original}".encode()).hexdigest()
    return "".join(c for c in digits if c.isdigit())[: len(original)]


def fake_merchant(original: str, salt: str) -> str:
    """Replace merchant/sector text deterministically."""
    return f"MERCHANT-{_hash8(original, salt)}"


# Column indices (0-based) in the data rows (after the sep= and header lines)
# Columns: Numéro de compte;Numéro de carte;Titulaire de compte/carte;
#          Date d'achat;Texte comptable;Secteur;Montant;Monnaie originale;
#          Cours;Monnaie;Débit;Crédit;Ecriture
ACCOUNT_COL = 0
CARD_COL = 1
HOLDER_COL = 2
DATE_COL = 3
MERCHANT_COL = 4
SECTOR_COL = 5


def anonymize(input_path: Path, output_path: Path, salt: str) -> None:
    """Anonymize sensitive columns in a UBS cards CSV file."""
    with open(input_path, "r", encoding="iso-8859-1") as f:
        lines = f.readlines()

    out_lines = []
    for i, line in enumerate(lines):
        # First line is sep=; — keep as-is
        # Second line is the header row — keep as-is
        if i < 2:
            out_lines.append(line)
            continue

        stripped = line.rstrip("\n")
        if not stripped:
            out_lines.append(line)
            continue

        cols = stripped.split(";")

        # Footer/summary lines have no account number — leave them as-is
        if not cols[ACCOUNT_COL].strip():
            out_lines.append(line)
            continue

        if len(cols) > ACCOUNT_COL and cols[ACCOUNT_COL].strip():
            cols[ACCOUNT_COL] = fake_account(cols[ACCOUNT_COL].strip(), salt)
        if len(cols) > CARD_COL and cols[CARD_COL].strip():
            cols[CARD_COL] = fake_card_number(cols[CARD_COL].strip(), salt)
        if len(cols) > HOLDER_COL and cols[HOLDER_COL].strip():
            cols[HOLDER_COL] = fake_name(cols[HOLDER_COL].strip(), salt)
        if len(cols) > DATE_COL and cols[DATE_COL].strip():
            cols[DATE_COL] = shift_dates_ch(cols[DATE_COL].strip(), salt)
        if len(cols) > MERCHANT_COL and cols[MERCHANT_COL].strip():
            cols[MERCHANT_COL] = fake_merchant(cols[MERCHANT_COL].strip(), salt)
        if len(cols) > SECTOR_COL and cols[SECTOR_COL].strip():
            cols[SECTOR_COL] = fake_merchant(cols[SECTOR_COL].strip(), salt)

        out_lines.append(";".join(cols) + "\n")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="iso-8859-1") as f:
        f.writelines(out_lines)

    print(f"Anonymized: {input_path} -> {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    anonymize(args.input, args.output, get_salt())
