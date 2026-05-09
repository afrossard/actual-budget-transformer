"""CAMT.053 XML output writer and document builder."""

import math
import uuid
from datetime import datetime
from decimal import Decimal

import pandas as pd
from pyiso20022.camt.camt_053_001_08.camt_053_001_08 import (
    AccountIdentification4Choice,
    AccountStatement9,
    ActiveOrHistoricCurrencyAndAmount,
    BalanceType10Choice,
    BalanceType13,
    BankToCustomerStatementV08,
    BankTransactionCodeStructure4,
    CashAccount39,
    CashBalance8,
    CreditDebitCode,
    DateAndDateTime2Choice,
    DateTimePeriod1,
    Document,
    EntryDetails9,
    EntryStatus1Choice,
    EntryTransaction10,
    GroupHeader81,
    Party40Choice,
    PartyIdentification135,
    ReportEntry10,
    TransactionParties6,
    TransactionReferences6,
)
from xsdata.formats.dataclass.serializers import XmlSerializer
from xsdata.formats.dataclass.serializers.config import SerializerConfig
from xsdata.models.datatype import XmlDate, XmlDateTime

from actual_budget_transformer.processors.camt053_parser import parse_camt053
from actual_budget_transformer.writers.base_writer import BaseWriter


def _to_xml_date(d) -> XmlDate:
    """Convert a date-like object to XmlDate."""
    if isinstance(d, XmlDate):
        return d
    return XmlDate(d.year, d.month, d.day)


def _to_xml_datetime(d) -> XmlDateTime:
    """Convert a date-like object to XmlDateTime (midnight)."""
    return XmlDateTime(d.year, d.month, d.day, 0, 0, 0)


def _safe_str(value) -> str:
    """Convert a value to string, treating NaN/None as empty."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value) if not pd.isna(value) else ""


def _build_entry(row, currency: str) -> ReportEntry10:
    """Build a single CAMT.053 entry from a DataFrame row."""
    debit = row["debit"]
    is_debit = not (math.isnan(debit) if isinstance(debit, float) else pd.isna(debit))
    amount = Decimal(str(row["debit"])) if is_debit else Decimal(str(row["credit"]))
    direction = CreditDebitCode.DBIT if is_debit else CreditDebitCode.CRDT

    # Build related parties with payee
    rltd_pties = None
    payee = _safe_str(row.get("payee", ""))
    if payee:
        party = Party40Choice(pty=PartyIdentification135(nm=payee))
        if is_debit:
            rltd_pties = TransactionParties6(cdtr=party)
        else:
            rltd_pties = TransactionParties6(dbtr=party)

    # Set transaction reference if available
    reference = _safe_str(row.get("reference", ""))
    refs = TransactionReferences6(acct_svcr_ref=reference) if reference else None
    tx_dtls = EntryTransaction10(refs=refs, rltd_pties=rltd_pties)
    ntry_dtls = EntryDetails9(tx_dtls=[tx_dtls])

    val_dt = DateAndDateTime2Choice(dt=_to_xml_date(row["transaction_date"]))

    notes = _safe_str(row.get("notes", ""))

    return ReportEntry10(
        amt=ActiveOrHistoricCurrencyAndAmount(value=amount, ccy=currency),
        cdt_dbt_ind=direction,
        sts=EntryStatus1Choice(cd="BOOK"),
        bookg_dt=val_dt,
        val_dt=val_dt,
        bk_tx_cd=BankTransactionCodeStructure4(),
        ntry_dtls=[ntry_dtls],
        addtl_ntry_inf=notes or None,
        acct_svcr_ref=reference or None,
    )


def build_camt053_document(df: pd.DataFrame, iban: str, currency: str = "CHF") -> str:
    """Build a CAMT.053 XML document from a DataFrame.

    Args:
        df: DataFrame with columns: transaction_date, payee, notes, debit, credit.
        iban: Account IBAN to embed in the statement.
        currency: Currency code (default CHF).

    Returns:
        XML string of the CAMT.053 document.
    """
    now = datetime.now()
    msg_id = uuid.uuid4().hex[:35]

    entries = [_build_entry(row, currency) for _, row in df.iterrows()]

    # Compute from/to date range
    if not df.empty:
        min_date = df["transaction_date"].min()
        max_date = df["transaction_date"].max()
    else:
        min_date = now
        max_date = now

    fr_to_dt = DateTimePeriod1(
        fr_dt_tm=_to_xml_datetime(min_date),
        to_dt_tm=_to_xml_datetime(max_date),
    )

    # A closing booked balance (CLBD) is required by the schema.
    # We don't track balances, so emit a zero placeholder.
    closing_bal = CashBalance8(
        tp=BalanceType13(cd_or_prtry=BalanceType10Choice(cd="CLBD")),
        amt=ActiveOrHistoricCurrencyAndAmount(value=Decimal("0"), ccy=currency),
        cdt_dbt_ind=CreditDebitCode.CRDT,
        dt=DateAndDateTime2Choice(dt=_to_xml_date(max_date)),
    )

    stmt = AccountStatement9(
        id=msg_id,
        acct=CashAccount39(
            id=AccountIdentification4Choice(iban=iban),
            ccy=currency,
        ),
        bal=[closing_bal],
        fr_to_dt=fr_to_dt,
        ntry=entries,
    )

    grp_hdr = GroupHeader81(
        msg_id=msg_id,
        cre_dt_tm=XmlDateTime(
            now.year,
            now.month,
            now.day,
            now.hour,
            now.minute,
            now.second,
        ),
    )

    doc = Document(
        bk_to_cstmr_stmt=BankToCustomerStatementV08(
            grp_hdr=grp_hdr,
            stmt=[stmt],
        )
    )

    serializer = XmlSerializer(config=SerializerConfig(pretty_print=True))
    ns_map = {"": "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"}
    return serializer.render(doc, ns_map=ns_map)


class Camt053Writer(BaseWriter):
    """Write transaction DataFrames as CAMT.053 XML files."""

    def __init__(self, account_id: str, currency: str = "CHF"):
        self.account_id = account_id
        self.currency = currency

    @property
    def file_extension(self) -> str:
        return ".xml"

    def read_existing(self, path: str) -> pd.DataFrame:
        _, entries, _ = parse_camt053(path)
        if not entries:
            from actual_budget_transformer.processors.base_processor import (
                ProcessingResult,
            )

            return pd.DataFrame(columns=ProcessingResult.COLUMNS)
        rows = []
        for e in entries:
            rows.append(
                {
                    "transaction_date": pd.Timestamp(e["date"]),
                    "payee": e["payee"],
                    "notes": e["notes"],
                    "debit": (
                        e["amount"] if e["direction"] == "DBIT" else float("nan")
                    ),
                    "credit": (
                        e["amount"] if e["direction"] == "CRDT" else float("nan")
                    ),
                    "reference": e["reference"],
                }
            )
        return pd.DataFrame(rows)

    def write_file(self, df: pd.DataFrame, path: str) -> None:
        xml_str = build_camt053_document(df, self.account_id, self.currency)
        with open(path, "w", encoding="utf-8") as f:
            f.write(xml_str)
