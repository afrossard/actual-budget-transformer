import os

from actual_budget_transformer.processors.ubs_csv_transaction_processor import (
    UBSCSVTransactionProcessor,
)
from tests.conftest import DATA_DIR


def test_can_process_valid_ubs_csv():
    file_path = os.path.join(DATA_DIR, "ubs_valid.csv")
    assert UBSCSVTransactionProcessor.can_process(file_path) is True


def test_can_process_invalid_extension():
    file_path = os.path.join(DATA_DIR, "ubs_invalid_extension.txt")
    assert UBSCSVTransactionProcessor.can_process(file_path) is False


def test_can_process_invalid_header():
    file_path = os.path.join(DATA_DIR, "ubs_invalid_header.csv")
    assert UBSCSVTransactionProcessor.can_process(file_path) is False


def test_can_process_invalid_transaction_columns():
    file_path = os.path.join(DATA_DIR, "ubs_invalid_transaction_columns.csv")
    assert UBSCSVTransactionProcessor.can_process(file_path) is False


def test_can_process_invalid_encoding():
    file_path = os.path.join(DATA_DIR, "ubs_invalid_encoding.csv")
    assert UBSCSVTransactionProcessor.can_process(file_path) is False
