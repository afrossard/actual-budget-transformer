#!/usr/bin/env python3
# pylint:disable=C0114
import argparse
import os
import sys
import logging
import pandas as pd
from actual_budget_transformer.factory import get_processor_for_file
from actual_budget_transformer.logging_config import logger
from actual_budget_transformer.config import load_config


def save_monthly_transactions(df, output_dir: str, output_prefix: str) -> None:
    """
    Split transactions by month and save to separate files.
    If a monthly file already exists, merge new transactions with it.

    Args:
        df: pandas DataFrame with transaction_date column
        output_dir: Directory to save the files
        output_prefix: Prefix to use for output filenames
    """
    # Convert transaction_date to datetime if it's not already
    df["transaction_date"] = pd.to_datetime(df["transaction_date"])

    # Get output date format from config
    config = load_config()
    output_date_format = config["output"]["date_format"]

    # Group by year and month using configured format
    grouped = df.groupby(df["transaction_date"].dt.strftime(output_date_format))

    # Track summary information
    files_created = []
    files_updated = []
    transactions_by_month = {}
    new_transactions_by_month = {}

    # Process each month's transactions
    for yearmonth, month_df in grouped:
        output_filename = f"{yearmonth}_{output_prefix}.csv"
        output_path = os.path.join(output_dir, output_filename)

        if os.path.exists(output_path):
            # Read existing file
            existing_df = pd.read_csv(output_path)
            existing_df["transaction_date"] = pd.to_datetime(
                existing_df["transaction_date"]
            )

            # Find new transactions by comparing all columns
            merged = month_df.merge(
                existing_df,
                on=["transaction_date", "payee", "notes", "debit", "credit"],
                how="left",
                indicator=True,
            )
            new_transactions = merged[merged["_merge"] == "left_only"].drop(
                columns=["_merge"]
            )

            if len(new_transactions) > 0:
                # Combine existing and new transactions
                combined_df = pd.concat([existing_df, new_transactions])

                # Sort by date
                combined_df = combined_df.sort_values("transaction_date")

                # Save updated file
                combined_df.to_csv(output_path, index=False)

                files_updated.append(output_filename)
                new_transactions_by_month[yearmonth] = len(new_transactions)
                transactions_by_month[yearmonth] = len(combined_df)

                logger.info(
                    "Added %d new transactions to existing file %s (total: %d)",
                    len(new_transactions),
                    output_filename,
                    len(combined_df),
                )
            else:
                transactions_by_month[yearmonth] = len(existing_df)
                new_transactions_by_month[yearmonth] = 0
                logger.info(
                    "No new transactions to add to %s (existing: %d)",
                    output_filename,
                    len(existing_df),
                )
        else:
            # Create new file
            month_df = month_df.sort_values("transaction_date")
            month_df.to_csv(output_path, index=False)

            files_created.append(output_filename)
            transactions_by_month[yearmonth] = len(month_df)
            new_transactions_by_month[yearmonth] = len(month_df)

            logger.info(
                "Created new file %s with %d transactions",
                output_filename,
                len(month_df),
            )

    # Print summary
    logger.info("\nProcessing summary:")
    if files_created:
        logger.info("New files created: %d", len(files_created))
        for filename in sorted(files_created):
            logger.info("  - %s", filename)

    if files_updated:
        logger.info("\nExisting files updated: %d", len(files_updated))
        for filename in sorted(files_updated):
            logger.info("  - %s", filename)

    logger.info("\nTransactions by month:")
    for yearmonth in sorted(transactions_by_month.keys()):
        total = transactions_by_month[yearmonth]
        new = new_transactions_by_month[yearmonth]
        if new > 0:
            logger.info("  %s: %d transactions (%d new)", yearmonth, total, new)
        else:
            logger.info("  %s: %d transactions (no changes)", yearmonth, total)

    logger.info(
        "\nTotal transactions across all files: %d", sum(transactions_by_month.values())
    )
    logger.info(
        "Total new transactions added: %d", sum(new_transactions_by_month.values())
    )


def process_single_file(file_path: str, output_dir: str | None = None) -> None:
    """Process a single file and optionally save to output directory."""
    logger.info("Processing %s...", file_path)
    processor = get_processor_for_file(file_path)
    result = processor.process(file_path)

    if output_dir:
        save_monthly_transactions(result.data, output_dir, result.output_prefix)
    else:
        total_transactions = len(result.data)
        logger.info("Preview of %d transactions:", total_transactions)
        logger.info("\n%s", result.data.head().to_string())
        logger.info("Showing 5 of %d transactions", total_transactions)


def process_directory(directory: str, output_dir: str | None = None) -> None:
    """Process all files in a directory that can be handled by available processors."""
    files_processed = 0
    files_skipped = 0

    logger.info("Processing directory: %s", directory)
    for root, _, files in os.walk(directory):
        for file in files:
            file_path = os.path.join(root, file)
            try:
                process_single_file(file_path, output_dir)
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

    args = parser.parse_args()

    # Set logging level based on verbosity
    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # Load configuration from file if provided. This will cache it for other modules.
    load_config(args.config_path)

    # Create output directory if specified and doesn't exist
    if args.output_dir:
        os.makedirs(args.output_dir, exist_ok=True)

    try:
        # Process input path
        if os.path.isfile(args.file_path):
            process_single_file(args.file_path, args.output_dir)
        elif os.path.isdir(args.file_path):
            process_directory(args.file_path, args.output_dir)
        else:
            logger.error("%s is not a valid file or directory", args.file_path)
            sys.exit(1)
    except (ValueError, OSError, pd.errors.EmptyDataError) as e:
        logger.error("Processing failed: %s", e, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
