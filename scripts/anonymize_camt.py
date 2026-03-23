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
"""

import hashlib
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# Matches IBANs: 2-letter country code, 2 check digits, 4-30 alphanumeric chars
_IBAN_RE = re.compile(r"[A-Z]{2}[0-9]{2}[A-Z0-9]{4,30}")


def _hash8(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:8].upper()


def fake_iban(original: str) -> str:
    """Keep country code and original length, replace the rest deterministically."""
    country = original[:2] if len(original) >= 2 else "XX"
    digits = (hashlib.sha256(original.encode()).hexdigest() * 2)[: len(original) - 2]
    # Use only alphanumeric chars matching IBAN charset
    digits = "".join(c for c in digits if c.isalnum()).upper()
    return (country + digits)[: len(original)]


def fake_name(original: str) -> str:
    """Return a deterministic anonymized name."""
    return f"ANON-{_hash8(original)}"


def fake_text(original: str) -> str:
    """Return a deterministic redacted placeholder."""
    return f"REDACTED-{_hash8(original)}"


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
    "AddtlTxInf",  # Additional transaction information
    "AddtlNtryInf",  # Additional entry information
}


def anonymize_filename(name: str) -> str:
    """Replace any IBANs found in a filename stem with their fake counterparts."""
    return _IBAN_RE.sub(lambda m: fake_iban(m.group()), name)


def anonymize(input_path: Path, output_path: Path) -> None:
    """Anonymize sensitive fields in a CAMT.053 XML file and write the result."""
    # Preserve all namespace declarations from the original document
    for _, elem in ET.iterparse(input_path, events=["start-ns"]):
        prefix, uri = elem  # type: ignore[misc]
        ET.register_namespace(prefix, uri)

    tree = ET.parse(input_path)
    root = tree.getroot()

    for elem in root.iter():
        local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        text = elem.text
        if not text or not text.strip():
            continue
        if local in IBAN_TAGS:
            elem.text = fake_iban(text.strip())
        elif local in NAME_TAGS:
            elem.text = fake_name(text.strip())
        elif local in TEXT_TAGS:
            elem.text = fake_text(text.strip())

    anon_filename = anonymize_filename(input_path.name)
    if output_path.is_dir() or not output_path.suffix:
        output_path = output_path / anon_filename
    else:
        output_path = output_path.parent / anonymize_filename(output_path.name)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tree.write(output_path, encoding="unicode", xml_declaration=True)
    print(f"Anonymized: {input_path} -> {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.xml> <output.xml>")
        sys.exit(1)
    anonymize(Path(sys.argv[1]), Path(sys.argv[2]))
