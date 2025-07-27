#!/bin/bash

# Configuration
INPUT_DIR="tmp/input_files"
OUTPUT_DIR="tmp/output_files"
CONFIG_FILE="config.yaml"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting transaction processing...${NC}"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Clear previous output
rm -f "$OUTPUT_DIR"/*

echo "Using:"
echo "- Input directory:  $INPUT_DIR"
echo "- Output directory: $OUTPUT_DIR"
echo "- Config file:     $CONFIG_FILE"
echo

# Run the processor
python -m actual_budget_transformer.main -f "$INPUT_DIR" -o "$OUTPUT_DIR" -c "$CONFIG_FILE" -v

# Check exit status
if [ $? -eq 0 ]; then
    echo -e "\n${GREEN}Processing completed successfully!${NC}"
    echo -e "\nProcessed files:"
    ls -l "$OUTPUT_DIR"
else
    echo -e "\n${RED}Processing failed!${NC}"
fi 
