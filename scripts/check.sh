#!/usr/bin/env bash
# The full local verification gate. CI runs the same steps in the same order.
#
# The stdout assertion is the one that cannot be expressed as an npm script:
# `2>&1 >/dev/null` proves the banner IS on stderr, rather than merely absent
# from stdout. The naive `>/dev/null 2>&1` would pass for a server that printed
# nothing at all, which is a different and weaker guarantee.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> node version"
node --version

echo "==> lint"
npm run lint

echo "==> format"
npm run format:check

echo "==> tests with enforced coverage"
npm run coverage

echo "==> stdout purity: --version writes zero bytes to stdout"
bytes=$(node src/mcp/main.js --version 2>/dev/null | wc -c)
if [ "$bytes" -ne 0 ]; then
  echo "FAIL: --version wrote $bytes byte(s) to stdout" >&2
  exit 1
fi

echo "==> and the banner IS on stderr"
if ! node src/mcp/main.js --version 2>&1 >/dev/null | grep -q "GenXEvo"; then
  echo "FAIL: the version banner is missing from stderr" >&2
  exit 1
fi

echo "==> production dependency tree"
npm ls --omit=dev

echo "==> package contents"
npm pack --dry-run

echo "ALL CHECKS PASSED"
