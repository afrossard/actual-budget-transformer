import hashlib
from dataclasses import dataclass

import pandas as pd

from actual_budget_transformer.config import load_config
from actual_budget_transformer.logging_config import logger
from actual_budget_transformer.processors.base_processor import (
    BaseProcessor,
    ProcessingResult,
)


@dataclass
class UBSCardsCSVTransactionProcessor(BaseProcessor):
    """Processor for UBS card transaction CSV files."""

    def _validate_headers(self, file_path: str, config: dict) -> bool:
        """Validate the CSV headers match expected format."""
        csv_settings = config["processors"]["ubs_cards"]["csv_settings"]
        expected_columns = config["processors"]["ubs_cards"]["expected_columns"]

        try:
            # Read just the header row
            df = pd.read_csv(
                file_path,
                encoding=csv_settings["encoding"],
                sep=csv_settings["separator"],
                skiprows=csv_settings["header_row"] - 1,
                nrows=1,
            )

            # Check if all expected columns are present
            return all(col in df.columns for col in expected_columns)
        except Exception:  # noqa: BLE001
            return False

    @classmethod
    def can_process(cls, file_path: str) -> bool:
        """Check if this processor can handle the file."""
        try:
            # First check for the sep=; line
            with open(file_path, encoding="iso-8859-1") as f:
                first_line = f.readline().strip()
                if first_line != "sep=;":
                    return False

            # Then validate the headers
            config = load_config()
            # Create instance for validation
            instance = cls()
            return instance._validate_headers(file_path, config)
        except Exception:  # noqa: BLE001
            return False

    def process(self, file_path: str) -> ProcessingResult:
        """Process a UBS cards CSV file."""
        config = load_config()
        processor_config = config["processors"]["ubs_cards"]
        csv_settings = processor_config["csv_settings"]
        account_names = processor_config["account_names"]
        date_format = processor_config["date_format"]

        # Validate headers before processing
        if not self._validate_headers(file_path, config):
            raise ValueError("Invalid file format: unexpected column headers")

        # Read CSV using configured settings
        df = pd.read_csv(
            file_path,
            encoding=csv_settings["encoding"],
            sep=csv_settings["separator"],
            skiprows=csv_settings["header_row"] - 1,
            dtype={"Numéro de carte": str, "Date d'achat": str},
        )
        df["Date d'achat"] = pd.to_datetime(
            df["Date d'achat"], format=date_format, errors="coerce"
        )

        # Get the card number before filtering (first data row always has it)
        card_number = df["Numéro de carte"].iloc[0]
        account_name = account_names.get(card_number, f"card_{card_number}")

        # Filter out pending transactions (no Débit or Crédit) and
        # footer/summary rows (no account number).
        raw_count = len(df)
        pending = df["Débit"].isna() & df["Crédit"].isna()
        footer = df["Numéro de compte"].isna()
        df = df[~(pending | footer)].reset_index(drop=True)
        skipped = raw_count - len(df)
        if skipped > 0:
            logger.info(
                "Skipped %d rows (pending/footer) from %s",
                skipped,
                file_path,
            )

        # Normalize column names and select relevant ones
        result = pd.DataFrame(
            {
                "transaction_date": df["Date d'achat"],
                "payee": df["Texte comptable"],
                "notes": df["Secteur"],
                "debit": df["Débit"].fillna(0),
                "credit": df["Crédit"].fillna(0),
            }
        )

        # Generate deterministic references from columns configured in
        # reference_columns (typically original-currency fields that are
        # stable across exports, unlike converted CHF amounts).
        # A per-group counter disambiguates identical transactions on the
        # same day (same merchant, same amount, same currency).
        ref_cols = processor_config["reference_columns"]
        occurrence = df.groupby(ref_cols).cumcount()
        result["reference"] = df[ref_cols].apply(
            lambda row: "|".join(str(v) for v in row),
            axis=1,
        )
        result["reference"] = (
            result["reference"] + "|" + occurrence.astype(str)
        ).apply(lambda key: hashlib.sha256(key.encode()).hexdigest()[:16])

        result = result[ProcessingResult.COLUMNS]

        return ProcessingResult(
            data=result,
            output_prefix=f"ubs_cards_{account_name.lower().replace(' ', '_')}",
            metadata={"account_id": card_number},
        )
