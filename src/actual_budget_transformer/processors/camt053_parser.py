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


class Camt053Balance(TypedDict):
    """Statement balance — typically OPBD (opening) or CLBD (closing)."""

    type_code: str  # 'OPBD', 'CLBD', 'CLAV', etc.
    date: datetime.date
    amount: float  # signed: positive = credit-side balance
    currency: str


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


def _extract_balances(stmt) -> list[Camt053Balance]:
    balances: list[Camt053Balance] = []
    for bal in stmt.bal or []:
        type_code = ""
        if bal.tp and bal.tp.cd_or_prtry and bal.tp.cd_or_prtry.cd:
            cd = bal.tp.cd_or_prtry.cd
            # `Cd` may surface as a plain str or as an enum-like with `.value`
            type_code = cd.value if hasattr(cd, "value") else str(cd)
        if not bal.amt or bal.dt is None or bal.dt.dt is None:
            continue
        ind = bal.cdt_dbt_ind
        ind_value = ind.value if hasattr(ind, "value") else str(ind) if ind else ""
        sign = 1 if ind_value == "CRDT" else -1
        balances.append(
            Camt053Balance(
                type_code=type_code,
                date=bal.dt.dt.to_date(),
                amount=sign * float(bal.amt.value),
                currency=bal.amt.ccy or "",
            )
        )
    return balances


def parse_camt053(
    file_path: str,
) -> tuple[str, list[Camt053Entry], list[Camt053Balance]]:
    """Parse a CAMT.053 XML file.

    Returns:
        ``(iban, entries, balances)``. ``balances`` lists every ``<Bal>``
        element in document order (OPBD, CLBD, CLAV, ...) with signed amounts.

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

    balances = _extract_balances(stmt)
    return iban, entries, balances
