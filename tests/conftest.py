import glob
import os

# Set config path before any test module imports processors
os.environ["ACTUAL_BUDGET_TRANSFORMER_CONFIG"] = os.path.join(
    os.path.dirname(__file__), "data", "test_config.yml"
)

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

SINGLE_DEBIT = os.path.join(DATA_DIR, "camt_single_debit.xml")
SINGLE_CREDIT = os.path.join(DATA_DIR, "camt_single_credit.xml")
MULTI_ENTRY = os.path.join(DATA_DIR, "camt_multi_entry.xml")
NO_ENTRIES = os.path.join(DATA_DIR, "camt_no_entries.xml")
VALDT_DIFFERS = os.path.join(DATA_DIR, "camt_valdt_differs.xml")
XML_FIXTURES = glob.glob(os.path.join(DATA_DIR, "*.xml"))
