"""CSV output writer."""

import pandas as pd

from actual_budget_transformer.writers.base_writer import BaseWriter


class CsvWriter(BaseWriter):
    """Write transaction DataFrames as CSV files."""

    @property
    def file_extension(self) -> str:
        return ".csv"

    def read_existing(self, path: str) -> pd.DataFrame:
        return pd.read_csv(path)

    def write_file(self, df: pd.DataFrame, path: str) -> None:
        df.to_csv(path, index=False)
