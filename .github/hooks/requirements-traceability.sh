#!/usr/bin/env bash
# PostToolUse hook — runs pnpm traceability:strict after any agent edit to
# REQUIREMENTS.md or tests/**/*.test.ts.
#
# Reads the VS Code hook payload from stdin (JSON), extracts the edited file
# path, and skips immediately if the path is not relevant.
#
# Exit codes:
#   0 — continue (traceability passed, or file not relevant)
#   0 — continue with warning message (traceability failed)
#
# The hook never blocks the agent (exit 2) — it surfaces failures as a
# systemMessage so the agent can decide how to proceed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Extract file path from the hook payload JSON.
# VS Code Copilot uses snake_case (tool_input.filePath); handle both casings.
# ---------------------------------------------------------------------------
file_path=$(node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(chunks.join(''));
    const inp = data.tool_input ?? data.toolInput ?? {};
    process.stdout.write(inp.filePath ?? inp.file_path ?? '');
  } catch {
    process.stdout.write('');
  }
});
")

# ---------------------------------------------------------------------------
# Only act on REQUIREMENTS.md or test files.
# ---------------------------------------------------------------------------
if [[ ! "$file_path" =~ (REQUIREMENTS\.md$|tests/.*\.test\.ts$) ]]; then
  printf '{"continue":true}'
  exit 0
fi

# ---------------------------------------------------------------------------
# Run the traceability gate.
# ---------------------------------------------------------------------------
if output=$(pnpm traceability:strict 2>&1); then
  printf '{"continue":true,"systemMessage":"Traceability check passed."}'
else
  # Trim and sanitize for embedding in a JSON string.
  summary=$(printf '%s' "$output" | grep -E '(unbound|orphan|FAIL|ERR|REQ-)' | head -10 \
    | sed 's/["\]/'"'"'/g' | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  if [[ -z "$summary" ]]; then
    summary=$(printf '%s' "$output" | head -5 | sed 's/["\]/'"'"'/g' | tr '\n' ' ')
  fi
  printf '{"continue":true,"systemMessage":"Traceability check failed after editing %s — %s. Run pnpm traceability:strict for full output."}' \
    "$(basename "$file_path")" "$summary"
fi
