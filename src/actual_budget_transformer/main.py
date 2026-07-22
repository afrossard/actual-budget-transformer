#!/usr/bin/env python3
import argparse
import logging
import os
import sys

import pandas as pd

from actual_budget_transformer.config import load_config
from actual_budget_transformer.factory import get_processor_for_file
from actual_budget_transformer.logging_config import logger
from actual_budget_transformer.writers.camt053_writer import Camt053Writer
from actual_budget_transformer.writers.csv_writer import CsvWriter


def _get_writers(output_format: str, metadata: dict) -> list:
    """Return the writer(s) for the requested output format."""
    writers = []
    if output_format in ("csv", "both"):
        writers.append(CsvWriter())
    if output_format in ("camt053", "both"):
        account_id = metadata.get("account_id", "UNKNOWN")
        writers.append(Camt053Writer(account_id))
    return writers


def process_single_file(
    file_path: str,
    output_dir: str | None = None,
    output_format: str = "csv",
) -> None:
    """Process a single file and optionally save to output directory."""
    logger.info("Processing %s...", file_path)
    processor = get_processor_for_file(file_path)
    result = processor.process(file_path)

    if output_dir:
        for writer in _get_writers(output_format, result.metadata):
            writer.save_monthly(result.data, output_dir, result.output_prefix)
    else:
        total_transactions = len(result.data)
        logger.info("Preview of %d transactions:", total_transactions)
        logger.info("\n%s", result.data.head().to_string())
        logger.info("Showing 5 of %d transactions", total_transactions)


def process_directory(
    directory: str,
    output_dir: str | None = None,
    output_format: str = "csv",
) -> None:
    """Process all files in a directory that can be handled by available processors."""
    files_processed = 0
    files_skipped = 0

    logger.info("Processing directory: %s", directory)
    for root, _, files in os.walk(directory):
        for file in files:
            file_path = os.path.join(root, file)
            try:
                process_single_file(file_path, output_dir, output_format)
                files_processed += 1
            except ValueError as e:
                logger.warning("Skipping %s: %s", file_path, e)
                files_skipped += 1

    logger.info("Directory processing complete:")
    logger.info("Files processed: %d", files_processed)
    logger.info("Files skipped: %d", files_skipped)


def main():
    """
    Main entry point for the actual-budget-transformer script.

    Parses command-line arguments to process financial data from a specified
    file or directory, and saves the output to a designated directory.
    """
    parser = argparse.ArgumentParser(description="Process financial data files.")
    parser.add_argument(
        "-f",
        "--file",
        dest="file_path",
        required=True,
        help="Path to input file or directory to process",
    )
    parser.add_argument(
        "-o",
        "--output",
        dest="output_dir",
        help="Output directory for processed files (optional)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "-c",
        "--config",
        dest="config_path",
        help="Path to the configuration file (optional)",
    )
    parser.add_argument(
        "--format",
        dest="output_format",
        choices=["csv", "camt053", "both"],
        default="csv",
        help="Output format: csv (default), camt053, or both",
    )

    args = parser.parse_args()

    # Set logging level based on verbosity. The level must be lowered on both
    # the logger and its handlers, otherwise handlers pinned at INFO would
    # filter out DEBUG records even when the logger accepts them.
    if args.verbose:
        logger.setLevel(logging.DEBUG)
        for handler in logger.handlers:
            handler.setLevel(logging.DEBUG)

    # Load configuration from file if provided. This will cache it for other modules.
    load_config(args.config_path)

    # Create output directory if specified and doesn't exist
    if args.output_dir:
        os.makedirs(args.output_dir, exist_ok=True)

    try:
        # Process input path
        if os.path.isfile(args.file_path):
            process_single_file(args.file_path, args.output_dir, args.output_format)
        elif os.path.isdir(args.file_path):
            process_directory(args.file_path, args.output_dir, args.output_format)
        else:
            logger.error("%s is not a valid file or directory", args.file_path)
            sys.exit(1)
    except (ValueError, OSError, pd.errors.EmptyDataError) as e:
        logger.error("Processing failed: %s", e, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
