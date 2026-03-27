#!/usr/bin/env python3
"""Anonymize a CAMT.053 XML file for use as test data.

Replaces sensitive fields (IBANs, names, addresses, remittance text, reference
IDs) with deterministic fakes so that the same input always produces the same
output — preserving relationships across transactions — while keeping amounts,
dates, currencies, and XML structure intact.

IBANs found in the input filename are also replaced in the output filename.

Usage:
    python scripts/anonymize_camt.py input.xml output_dir/
    python scripts/anonymize_camt.py input.xml output.xml

The salt is read from the ``ANONYMIZE_SALT`` environment variable, or prompted
interactively (not echoed). To set it without it appearing in shell history:

    read -s ANONYMIZE_SALT && export ANONYMIZE_SALT
"""

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _anonymize_utils import (  # pylint: disable=wrong-import-position
    _hash8,
    fake_iban,
    fake_name,
    fake_text,
    get_salt,
    shift_dates_iso,
)

# Matches alphanumeric tokens of 8+ characters in filenames (identifiers,
# IBANs, statement IDs, etc.).  Short tokens like "Z53" or "CHF" are kept.
_ID_TOKEN_RE = re.compile(r"[A-Za-z0-9]{8,}")


# Local XML tag names whose text content should be anonymized
IBAN_TAGS = {"IBAN"}
NAME_TAGS = {"Nm"}
TEXT_TAGS = {
    "Ustrd",  # Unstructured remittance info
    "EndToEndId",  # End-to-end reference
    "TxId",  # Transaction ID
    "InstrId",  # Instruction ID
    "MsgId",  # Message ID
    "AcctSvcrRef",  # Account servicer reference
    "AdrLine",  # Address line
    "Pstl",  # Postal code
    "TwnNm",  # Town name
    "AddtlTxInf",  # Additional transaction information
    "AddtlNtryInf",  # Additional entry information
    "BICFI",  # BIC code (identifies counterparty bank)
    "BIC",  # BIC code (alternative tag)
}


def anonymize_filename(name: str, salt: str) -> str:
    """Replace long alphanumeric tokens and shift dates in a filename."""
    name = shift_dates_iso(name, salt)
    return _ID_TOKEN_RE.sub(lambda m: _hash8(m.group(), salt), name)


def anonymize(  # pylint: disable=too-many-branches
    input_path: Path, output_path: Path, salt: str
) -> None:
    """Anonymize sensitive fields in a CAMT.053 XML file and write the result."""
    # Preserve all namespace declarations from the original document
    for _, elem in ET.iterparse(input_path, events=["start-ns"]):
        prefix, uri = elem  # type: ignore[misc]
        ET.register_namespace(prefix, uri)

    tree = ET.parse(input_path)
    root = tree.getroot()

    # Anonymize Stmt/Id elements (statement identifier — too generic to match
    # by tag name alone since <Id> appears in many unrelated contexts).
    for stmt_id in root.findall(".//{*}Stmt/{*}Id"):
        if stmt_id.text and stmt_id.text.strip():
            stmt_id.text = fake_text(stmt_id.text.strip(), salt)

    for elem in root.iter():
        local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        text = elem.text
        if not text or not text.strip():
            continue
        if local in IBAN_TAGS:
            elem.text = fake_iban(text.strip(), salt)
        elif local in NAME_TAGS:
            elem.text = fake_name(text.strip(), salt)
        elif local in TEXT_TAGS:
            elem.text = fake_text(text.strip(), salt)

    # Shift all ISO dates (YYYY-MM-DD) in every element's text
    for elem in root.iter():
        if elem.text:
            shifted = shift_dates_iso(elem.text, salt)
            if shifted != elem.text:
                elem.text = shifted

    anon_filename = anonymize_filename(input_path.name, salt)
    if output_path.is_dir() or not output_path.suffix:
        output_path = output_path / anon_filename
    else:
        output_path = output_path.parent / anonymize_filename(output_path.name, salt)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tree.write(output_path, encoding="unicode", xml_declaration=True)
    print(f"Anonymized: {input_path} -> {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    anonymize(args.input, args.output, get_salt())
