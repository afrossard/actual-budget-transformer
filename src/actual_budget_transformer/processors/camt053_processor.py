"""Processor for CAMT.053 XML bank statement files (ISO 20022)."""

import os
import xml.etree.ElementTree as ET

import pandas as pd

from actual_budget_transformer.config import get_account_name
from actual_budget_transformer.logging_config import logger
from actual_budget_transformer.processors.base_processor import (
    BaseProcessor,
    ProcessingResult,
)
from actual_budget_transformer.processors.camt053_parser import parse_camt053

CAMT053_NAMESPACE_FRAGMENT = "camt.053"


class Camt053Processor(BaseProcessor):
    """Process CAMT.053 XML bank statement files."""

    @classmethod
    def can_process(cls, file_path) -> bool:
        _, ext = os.path.splitext(file_path)
        if ext.lower() != ".xml":
            logger.debug("Rejected %s: not an .xml file", file_path)
            return False

        try:
            for _, elem in ET.iterparse(file_path, events=("start",)):
                tag = (
                    elem.tag
                )  # e.g. '{urn:iso:std:iso:20022:tech:xsd:camt.053.001.08}Document'
                if CAMT053_NAMESPACE_FRAGMENT in tag:
                    return True
                # Only check the root element
                break
        except ET.ParseError as e:
            logger.debug("Rejected %s: XML parse error (%s)", file_path, e)
            return False
        except OSError as e:
            logger.debug("Rejected %s: cannot read file (%s)", file_path, e)
            return False

        logger.debug(
            "Rejected %s: root namespace does not contain '%s'",
            file_path,
            CAMT053_NAMESPACE_FRAGMENT,
        )
        return False

    def process(self, file_path) -> ProcessingResult:
        """Parse a CAMT.053 file and return a normalised ProcessingResult."""
        logger.debug("Processing CAMT.053 file: %s", file_path)
        iban, entries = parse_camt053(file_path)

        if entries:
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
            df = pd.DataFrame(rows, columns=ProcessingResult.COLUMNS)
        else:
            df = pd.DataFrame(columns=ProcessingResult.COLUMNS)

        account_name = get_account_name(iban, processor_name="camt053")
        output_prefix = f"camt053_{account_name}"
        logger.debug("Using output prefix: %s", output_prefix)

        return ProcessingResult(data=df, output_prefix=output_prefix)
