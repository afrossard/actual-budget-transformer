"""Logging configuration for the actual_budget_transformer package."""

import logging
import sys


def setup_logging(level=logging.INFO):
    """
    Configure logging for the actual_budget_transformer package.

    Args:
        level: The logging level to use. Defaults to INFO.
    """
    # Create logger
    logger = logging.getLogger("actual_budget_transformer")
    logger.setLevel(level)

    # Remove any existing handlers to avoid duplicates
    logger.handlers.clear()

    # Create console handler with formatting
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)

    # Create formatters and add it to the handlers
    detailed_formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    console_handler.setFormatter(detailed_formatter)

    # Add handlers to the logger
    logger.addHandler(console_handler)

    return logger


# Create a default logger instance
logger = setup_logging()
