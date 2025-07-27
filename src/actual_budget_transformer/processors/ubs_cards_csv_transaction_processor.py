from dataclasses import dataclass
import pandas as pd
from actual_budget_transformer.processors.base_processor import BaseProcessor, ProcessingResult
from actual_budget_transformer.config import load_config


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
        except Exception:  # pylint: disable=broad-except
            return False

    @classmethod
    def can_process(cls, file_path: str) -> bool:
        """Check if this processor can handle the file."""
        try:
            # First check for the sep=; line
            with open(file_path, "r", encoding="iso-8859-1") as f:
                first_line = f.readline().strip()
                if first_line != "sep=;":
                    return False

            # Then validate the headers
            config = load_config()
            # Create instance for validation
            instance = cls()
            return instance._validate_headers(file_path, config)
        except Exception:  # pylint: disable=broad-except
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
            parse_dates=["Date d'achat"],
            date_parser=lambda x: pd.to_datetime(x, format=date_format),
        )

        # Get the card number and map it to an account name
        card_number = df["Numéro de carte"].iloc[0]
        account_name = account_names.get(card_number, f"card_{card_number}")

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

        return ProcessingResult(
            data=result,
            output_prefix=f"ubs_cards_{account_name.lower().replace(' ', '_')}",
        )
