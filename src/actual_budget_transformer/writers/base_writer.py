"""Base writer with shared monthly-split and dedup orchestration."""

import os
from abc import ABC, abstractmethod

import pandas as pd

from actual_budget_transformer.config import load_config
from actual_budget_transformer.logging_config import logger


class BaseWriter(ABC):
    """Abstract base for output writers.

    Subclasses implement format-specific read/write; this class owns the
    shared logic for splitting by month and deduplicating against existing
    output files.
    """

    @property
    @abstractmethod
    def file_extension(self) -> str:
        """File extension including the dot, e.g. '.csv' or '.xml'."""

    @abstractmethod
    def read_existing(self, path: str) -> pd.DataFrame:
        """Read a previously-written output file back into a DataFrame."""

    @abstractmethod
    def write_file(self, df: pd.DataFrame, path: str) -> None:
        """Write a DataFrame to a file in this writer's format."""

    def _deduplicate(
        self, existing_df: pd.DataFrame, new_df: pd.DataFrame
    ) -> pd.DataFrame:
        """Merge new transactions into existing, removing duplicates.

        Uses ``reference`` when available (non-empty on all rows),
        otherwise falls back to content-based comparison.
        """
        text_cols = ["payee", "notes"]
        existing_df[text_cols] = existing_df[text_cols].fillna("")
        new_df[text_cols] = new_df[text_cols].fillna("")

        has_refs = (
            "reference" in existing_df.columns
            and "reference" in new_df.columns
            and existing_df["reference"].notna().all()
            and (existing_df["reference"] != "").all()
            and new_df["reference"].notna().all()
            and (new_df["reference"] != "").all()
        )

        if has_refs:
            subset = ["reference"]
        else:
            subset = [
                "transaction_date",
                "payee",
                "notes",
                "debit",
                "credit",
            ]

        combined = pd.concat([existing_df, new_df])
        return combined.drop_duplicates(subset=subset, keep="first")

    def save_monthly(
        self, df: pd.DataFrame, output_dir: str, output_prefix: str
    ) -> None:
        """Split transactions by month and save, merging with existing files."""
        df["transaction_date"] = pd.to_datetime(df["transaction_date"])

        config = load_config()
        date_fmt = config["output"]["date_format"]
        grouped = df.groupby(df["transaction_date"].dt.strftime(date_fmt))

        files_created = []
        files_updated = []
        transactions_by_month = {}
        new_transactions_by_month = {}

        for yearmonth, month_df in grouped:
            filename = f"{yearmonth}_{output_prefix}{self.file_extension}"
            path = os.path.join(output_dir, filename)

            if os.path.exists(path):
                existing_df = self.read_existing(path)
                existing_df["transaction_date"] = pd.to_datetime(
                    existing_df["transaction_date"]
                )
                combined_df = self._deduplicate(existing_df, month_df)
                new_count = len(combined_df) - len(existing_df)

                if new_count > 0:
                    combined_df = combined_df.sort_values("transaction_date")
                    self.write_file(combined_df, path)
                    files_updated.append(filename)
                    new_transactions_by_month[yearmonth] = new_count
                    transactions_by_month[yearmonth] = len(combined_df)
                    logger.info(
                        "Added %d new transactions to %s (total: %d)",
                        new_count,
                        filename,
                        len(combined_df),
                    )
                else:
                    transactions_by_month[yearmonth] = len(existing_df)
                    new_transactions_by_month[yearmonth] = 0
                    logger.info(
                        "No new transactions to add to %s (existing: %d)",
                        filename,
                        len(existing_df),
                    )
            else:
                month_df = month_df.sort_values("transaction_date")
                self.write_file(month_df, path)
                files_created.append(filename)
                transactions_by_month[yearmonth] = len(month_df)
                new_transactions_by_month[yearmonth] = len(month_df)
                logger.info(
                    "Created %s with %d transactions",
                    filename,
                    len(month_df),
                )

        _log_summary(
            files_created,
            files_updated,
            transactions_by_month,
            new_transactions_by_month,
        )


def _log_summary(files_created, files_updated, tx_by_month, new_by_month):
    """Log a processing summary."""
    logger.info("\nProcessing summary:")
    if files_created:
        logger.info("New files created: %d", len(files_created))
        for f in sorted(files_created):
            logger.info("  - %s", f)

    if files_updated:
        logger.info("\nExisting files updated: %d", len(files_updated))
        for f in sorted(files_updated):
            logger.info("  - %s", f)

    logger.info("\nTransactions by month:")
    for ym in sorted(tx_by_month.keys()):
        total = tx_by_month[ym]
        new = new_by_month[ym]
        if new > 0:
            logger.info("  %s: %d transactions (%d new)", ym, total, new)
        else:
            logger.info("  %s: %d transactions (no changes)", ym, total)

    logger.info(
        "\nTotal transactions across all files: %d",
        sum(tx_by_month.values()),
    )
    logger.info(
        "Total new transactions added: %d",
        sum(new_by_month.values()),
    )
