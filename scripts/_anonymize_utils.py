"""Shared hashing utilities for anonymization scripts."""

import getpass
import hashlib
import os
import re
from datetime import datetime, timedelta


def get_salt() -> str:
    """Return the anonymization salt.

    Resolution order:
    1. ``ANONYMIZE_SALT`` environment variable (suitable for scripting: set it
       with ``read -s ANONYMIZE_SALT && export ANONYMIZE_SALT`` so the value
       never appears in shell history or process listings).
    2. Interactive prompt via ``getpass`` (input is not echoed to the terminal).
    """
    salt = os.environ.get("ANONYMIZE_SALT")
    if salt:
        return salt
    return getpass.getpass("Salt: ")


def _hash8(value: str, salt: str) -> str:
    """Return an 8-character uppercase hex digest of the salted value."""
    return hashlib.sha256(f"{salt}:{value}".encode()).hexdigest()[:8].upper()


def fake_iban(original: str, salt: str) -> str:
    """Keep country code and length, replace the rest deterministically.

    Preserves any spaces present in the original (e.g. 'CH42 0012 ...')."""
    clean = original.replace(" ", "")
    country = clean[:2] if len(clean) >= 2 else "XX"
    digits = (hashlib.sha256(f"{salt}:{clean}".encode()).hexdigest() * 2)[
        : len(clean) - 2
    ]
    digits = "".join(c for c in digits if c.isalnum()).upper()
    fake = (country + digits)[: len(clean)]
    result, j = [], 0
    for ch in original:
        if ch == " ":
            result.append(" ")
        else:
            result.append(fake[j])
            j += 1
    return "".join(result)


def fake_name(original: str, salt: str) -> str:
    """Return a deterministic anonymized name."""
    return f"ANON-{_hash8(original, salt)}"


def fake_account(original: str, salt: str) -> str:
    """Return a deterministic fake account number."""
    return f"ANON-ACCT-{_hash8(original, salt)}"


def fake_text(original: str, salt: str) -> str:
    """Return a deterministic redacted placeholder."""
    return f"REDACTED-{_hash8(original, salt)}"


def _get_date_shift(salt: str) -> int:
    """Derive a deterministic day-shift (30–9999) from the salt."""
    h = hashlib.sha256(f"{salt}:date_shift".encode()).digest()
    return int.from_bytes(h[:4], "big") % 9970 + 30


# Matches YYYY-MM-DD anywhere in a string (also inside datetimes like
# 2026-03-16T10:30:00+01:00).
_ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

# Matches DD.MM.YYYY (Swiss date format).
_CH_DATE_RE = re.compile(r"\d{2}\.\d{2}\.\d{4}")


def shift_date(date_str: str, fmt: str, salt: str) -> str:
    """Shift a single date string backward by a salt-derived number of days."""
    dt = datetime.strptime(date_str, fmt)
    return (dt - timedelta(days=_get_date_shift(salt))).strftime(fmt)


def shift_dates_iso(text: str, salt: str) -> str:
    """Shift all YYYY-MM-DD dates found in *text*."""
    return _ISO_DATE_RE.sub(lambda m: shift_date(m.group(), "%Y-%m-%d", salt), text)


def shift_dates_ch(text: str, salt: str) -> str:
    """Shift all DD.MM.YYYY dates found in *text*."""
    return _CH_DATE_RE.sub(lambda m: shift_date(m.group(), "%d.%m.%Y", salt), text)
