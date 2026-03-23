#!/usr/bin/env python3
"""Anonymize a UBS cards CSV file for use as test data.

Replaces sensitive fields (account number, card number, cardholder name,
merchant names) with deterministic fakes while preserving dates, amounts,
currencies, and CSV structure.

Usage:
    python scripts/anonymize_ubs_cards.py input.csv output.csv
"""

import hashlib
import sys
from pathlib import Path


def _hash8(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:8].upper()


def fake_card_number(original: str) -> str:
    """Replace card digits deterministically, preserving length."""
    digits = hashlib.sha256(original.encode()).hexdigest()
    return "".join(c for c in digits if c.isdigit())[: len(original)]


def fake_account_number(original: str) -> str:
    """Replace account number deterministically."""
    return f"ANON-ACCT-{_hash8(original)}"


def fake_name(original: str) -> str:
    """Replace a name deterministically."""
    return f"ANON-{_hash8(original)}"


def fake_text(original: str) -> str:
    """Replace free text deterministically."""
    return f"MERCHANT-{_hash8(original)}"


# Column indices (0-based) in the data rows (after the sep= and header lines)
# Columns: Numéro de compte;Numéro de carte;Titulaire de compte/carte;
#          Date d'achat;Texte comptable;Secteur;Montant;Monnaie originale;
#          Cours;Monnaie;Débit;Crédit;Ecriture
ACCOUNT_COL = 0
CARD_COL = 1
HOLDER_COL = 2
MERCHANT_COL = 4
SECTOR_COL = 5


def anonymize(input_path: Path, output_path: Path) -> None:
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
            cols[ACCOUNT_COL] = fake_account_number(cols[ACCOUNT_COL].strip())
        if len(cols) > CARD_COL and cols[CARD_COL].strip():
            cols[CARD_COL] = fake_card_number(cols[CARD_COL].strip())
        if len(cols) > HOLDER_COL and cols[HOLDER_COL].strip():
            cols[HOLDER_COL] = fake_name(cols[HOLDER_COL].strip())
        if len(cols) > MERCHANT_COL and cols[MERCHANT_COL].strip():
            cols[MERCHANT_COL] = fake_text(cols[MERCHANT_COL].strip())
        if len(cols) > SECTOR_COL and cols[SECTOR_COL].strip():
            cols[SECTOR_COL] = fake_text(cols[SECTOR_COL].strip())

        out_lines.append(";".join(cols) + "\n")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="iso-8859-1") as f:
        f.writelines(out_lines)

    print(f"Anonymized: {input_path} -> {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.csv> <output.csv>")
        sys.exit(1)
    anonymize(Path(sys.argv[1]), Path(sys.argv[2]))
