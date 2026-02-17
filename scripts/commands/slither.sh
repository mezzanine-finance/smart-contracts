#!/usr/bin/env bash

set -euo pipefail

echo

if ! command -v slither > /dev/null 2>&1; then
    echo "Slither is not found."
    echo "Please, install Slither: "
    echo "\`https://github.com/crytic/slither?tab=readme-ov-file#how-to-install\`."
    echo
    exit 1
fi

REPORT_PATH="./reports/SLITHER_REPORT.md"
TMP_OUTPUT_FILE="./reports/slither-cmd-output.txt"

echo "Running Slither..."
mkdir -p ./reports
SLITHER_STATUS=0
slither . --checklist --config-file ./slither.config.json --foundry-out-directory out-foundry > "$REPORT_PATH" 2> "$TMP_OUTPUT_FILE" || SLITHER_STATUS=$?
if [ "${SLITHER_STRICT:-false}" = "true" ] && [ "$SLITHER_STATUS" -ne 0 ]; then
    echo "Slither strict mode: exiting with code $SLITHER_STATUS."
    exit "$SLITHER_STATUS"
fi
if [ "$SLITHER_STATUS" -ne 0 ] && [ "$SLITHER_STATUS" -ne 255 ]; then
    echo "Slither failed with exit code $SLITHER_STATUS."
    exit "$SLITHER_STATUS"
fi

echo "Preparing the Slither report..."
echo "* * *" >> "$REPORT_PATH"
echo "" >> "$REPORT_PATH"

sed 's/$/\n/' "$TMP_OUTPUT_FILE" | cat >> "$REPORT_PATH"

rm -f "$TMP_OUTPUT_FILE"

echo
echo "The Slither report is stored in $REPORT_PATH."
echo
