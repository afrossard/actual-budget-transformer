"""
Processor Factory Module

This module provides a registry of all available file processors and a factory function
to select the appropriate processor for a given file. Each processor must implement
the BaseProcessor interface, including a class method `can_process` to determine if
it can handle a specific file.

Usage:
    from factory import get_processor_for_file

    processor = get_processor_for_file(file_path)
    df = processor.process(file_path)

Raises:
    ValueError: If no suitable processor is found for the provided file.
"""

from actual_budget_transformer.processors.base_processor import BaseProcessor
from actual_budget_transformer.processors.ubs_csv_transaction_processor import (
    UBSCSVTransactionProcessor,
)
from actual_budget_transformer.processors.ubs_cards_csv_transaction_processor import (
    UBSCardsCSVTransactionProcessor,
)

PROCESSORS = [
    UBSCSVTransactionProcessor,
    UBSCardsCSVTransactionProcessor,
    # Add more processors here
]


def get_processor_for_file(file_path: str) -> BaseProcessor:
    """
    Returns an instance of the first processor that can handle the given file.

    Args:
        file_path (str): Path to the file to be processed.

    Returns:
        BaseProcessor: An instance of a processor capable of handling the file.

    Raises:
        ValueError: If no suitable processor is found.
    """
    for processor_cls in PROCESSORS:
        if processor_cls.can_process(file_path):
            return processor_cls()
    raise ValueError(f"No processor found for file: {file_path}")
