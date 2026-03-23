# pylint: disable=missing-function-docstring,missing-module-docstring
import os

# Set config path before any test module imports processors
os.environ["ACTUAL_BUDGET_TRANSFORMER_CONFIG"] = os.path.join(
    os.path.dirname(__file__), "data", "test_config.yml"
)

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
