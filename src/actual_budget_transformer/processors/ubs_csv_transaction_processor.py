"""
Processor for UBS CSV Transactions extracted from accounts (not UBS cards)
"""

import os
import pandas as pd
from actual_budget_transformer.processors.base_processor import BaseProcessor, ProcessingResult
from actual_budget_transformer.logging_config import logger
from actual_budget_transformer.config import get_account_name, get_processor_config


# pylint: disable=C0115
class UBSCSVTransactionProcessor(BaseProcessor):
    """Process UBS CSV transaction files."""

    def __init__(self):
        # Get processor configuration
        self.config = get_processor_config("ubs_csv")

        # CSV settings from config
        self.csv_settings = self.config["csv_settings"]
        self.header_rows = self.csv_settings["header_rows"]
        self.expected_columns = self.csv_settings["expected_columns"]
        self.encoding = self.csv_settings["encoding"]
        self.separator = self.csv_settings["separator"]

        # Expected labels from config
        self.expected_header_labels = self.config["expected_header_labels"]
        self.expected_transaction_labels = self.config["expected_transaction_labels"]

        # Date format from config
        self.date_format = self.config["date_format"]

    @classmethod
    def can_process(cls, file_path) -> bool:
        _, ext = os.path.splitext(file_path)
        if ext.lower() != ".csv":
            logger.debug("Rejected %s: file has no .csv extension", file_path)
            return False

        # Create temporary instance to get config
        instance = cls()

        try:
            # Read header rows
            rows = pd.read_csv(
                file_path,
                sep=instance.separator,
                nrows=instance.header_rows,
                header=None,
                encoding=instance.encoding,
            )
        except (FileNotFoundError, pd.errors.ParserError, UnicodeDecodeError) as e:
            logger.debug("Failed to read %s: %s", file_path, e)
            return False

        # Check header labels
        if rows.shape[0] < instance.header_rows or rows.shape[1] < 2:
            logger.debug(
                "Rejected %s: file lacks the expected %s header rows with 2 columns each",
                file_path,
                instance.header_rows,
            )
            return False

        for i, label in enumerate(instance.expected_header_labels):
            actual = rows.iloc[i, 0].strip()
            if actual != label:
                logger.debug(
                    "Rejected %s: header label mismatch at row %d (expected '%s', found '%s')",
                    file_path,
                    i + 1,
                    label,
                    actual,
                )
                return False

        try:
            # Read transaction headers
            rows = pd.read_csv(
                file_path,
                sep=instance.separator,
                skiprows=instance.header_rows,
                encoding=instance.encoding,
                nrows=0,  # Only read the header
            )
        except (FileNotFoundError, pd.errors.ParserError, UnicodeDecodeError) as e:
            logger.debug("Failed to read %s: %s", file_path, e)
            return False

        # Check transaction section columns
        transaction_headers = [col.strip() for col in rows.columns.tolist()]
        if transaction_headers != instance.expected_transaction_labels:
            logger.debug(
                "Rejected %s: transaction section columns mismatch.\nExpected: %s\nFound: %s",
                file_path,
                instance.expected_transaction_labels,
                transaction_headers,
            )
            return False

        logger.debug("%s accepted as UBS CSV transaction file", file_path)
        return True

    def process(self, file_path):
        logger.debug("Processing UBS CSV file: %s", file_path)
        try:
            # Read header rows
            header_rows = pd.read_csv(
                file_path,
                sep=self.separator,
                nrows=self.header_rows,
                header=None,
                encoding=self.encoding,
            )
        except (FileNotFoundError, pd.errors.ParserError, UnicodeDecodeError) as e:
            logger.error("Failed to read %s: %s", file_path, e)
            raise ValueError(f"Failed to read the file: {e}") from e

        # Read header labels
        account_number = header_rows.iloc[0, 1]
        iban = header_rows.iloc[1, 1]
        logger.debug("Processing account %s (IBAN: %s)", account_number, iban)

        try:
            # Read transactions with date column as object first
            df = pd.read_csv(
                file_path,
                sep=self.separator,
                skiprows=self.header_rows,
                encoding=self.encoding,
                dtype={"Date de transaction": "object"},
            )

            # Then convert the date column using to_datetime
            df["Date de transaction"] = pd.to_datetime(
                df["Date de transaction"], format=self.date_format
            )
        except (FileNotFoundError, pd.errors.ParserError, UnicodeDecodeError) as e:
            logger.error("Failed to read transactions from %s: %s", file_path, e)
            raise ValueError(f"Failed to read the file: {e}") from e

        df.columns = [
            "transaction_date",
            "transaction_time",
            "posting_date",
            "value_date",
            "currency",
            "debit",
            "credit",
            "sub_amount",
            "balance",
            "transaction_number",
            "payee",
            "description2",
            "description3",
            "footnotes",
            "other_info",
        ]

        df["notes"] = df[
            ["description2", "description3", "footnotes", "other_info"]
        ].apply(lambda x: " ".join(filter(None, x.astype(str))), axis=1)

        # Keep only the columns we want
        df = df[["transaction_date", "payee", "notes", "debit", "credit"]]

        # Get friendly name from config
        account_name = get_account_name(iban)
        output_prefix = f"ubs_{account_name}"
        logger.debug("Using output prefix: %s", output_prefix)

        return ProcessingResult(data=df, output_prefix=output_prefix)
