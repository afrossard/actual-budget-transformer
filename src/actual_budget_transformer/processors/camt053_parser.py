"""Parser utility for CAMT.053 bank statement files (ISO 20022)."""

import datetime
from typing import TypedDict

from pyiso20022.camt.camt_053_001_08.camt_053_001_08 import Document
from xsdata.formats.dataclass.parsers import XmlParser


class Camt053Entry(TypedDict):
    """Normalised representation of a single CAMT.053 transaction entry."""

    date: datetime.date
    amount: float
    direction: str  # 'DBIT' or 'CRDT'
    payee: str
    notes: str
    reference: str


def _extract_payee_and_notes(ntry) -> tuple[str, str]:
    """Extract payee name and notes from a CAMT.053 entry's transaction details."""
    notes = ntry.addtl_ntry_inf or ""
    payee = ""
    if not ntry.ntry_dtls:
        return payee, notes
    tx = ntry.ntry_dtls[0].tx_dtls[0] if ntry.ntry_dtls[0].tx_dtls else None
    if not tx:
        return payee, notes
    if tx.rltd_pties:
        cdtr = tx.rltd_pties.cdtr
        dbtr = tx.rltd_pties.dbtr
        if cdtr and cdtr.pty and cdtr.pty.nm:
            payee = cdtr.pty.nm
        elif dbtr and dbtr.pty and dbtr.pty.nm:
            payee = dbtr.pty.nm
    if not notes and tx.rmt_inf and tx.rmt_inf.ustrd:
        notes = tx.rmt_inf.ustrd[0]
    return payee, notes


def parse_camt053(file_path: str) -> tuple[str, list[Camt053Entry]]:
    """Parse a CAMT.053 XML file and return the account IBAN and a list of entries.

    Args:
        file_path: Path to the CAMT.053 XML file.

    Returns:
        A tuple of (iban, entries) where each entry has keys:
        date, amount, direction ('DBIT'/'CRDT'), payee, notes.

    Raises:
        ValueError: If the file cannot be parsed as a CAMT.053 document.
    """
    try:
        parser = XmlParser()
        doc = parser.parse(file_path, Document)
    except Exception as e:
        raise ValueError(f"Failed to parse CAMT.053 file {file_path}: {e}") from e

    stmt = doc.bk_to_cstmr_stmt.stmt[0]
    iban = stmt.acct.id.iban

    entries: list[Camt053Entry] = []
    for ntry in stmt.ntry:
        amount = float(ntry.amt.value)
        direction = ntry.cdt_dbt_ind.value  # 'DBIT' or 'CRDT'
        val_dt = ntry.val_dt and ntry.val_dt.dt
        date = val_dt.to_date() if val_dt else ntry.bookg_dt.dt.to_date()

        payee, notes = _extract_payee_and_notes(ntry)

        reference = ntry.acct_svcr_ref or ""

        entries.append(
            Camt053Entry(
                date=date,
                amount=amount,
                direction=direction,
                payee=payee,
                notes=notes,
                reference=reference,
            )
        )

    return iban, entries
