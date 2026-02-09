#!/usr/bin/env bash

set -euo pipefail

mkdir -p ./reports

aderyn --output ./reports/aderyn-report.md

# If a default report was produced anyway, move it into reports.
if [ -f ./report.md ]; then
    mv -f ./report.md ./reports/aderyn-report.md
fi
