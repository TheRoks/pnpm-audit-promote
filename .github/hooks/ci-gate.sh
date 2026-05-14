#!/usr/bin/env bash
# Stop hook — runs pnpm format:check && pnpm lint at the end of every agent
# session so formatting and lint violations are surfaced before the agent
# signs off.
#
# Reads the VS Code hook payload from stdin (JSON) — for Stop events the
# payload has no file path, so we run unconditionally.
#
# Exit codes:
#   0 — continue (gate passed, or failure surfaced as systemMessage)
#
# The hook never blocks the agent (exit 2) — it surfaces failures as a
# systemMessage so the agent can decide how to proceed.

set -uo pipefail

# Drain stdin (payload not used for Stop events).
cat > /dev/null

# ---------------------------------------------------------------------------
# Helper: sanitise a multi-line string for embedding in a JSON string value.
# Strips double-quotes and backslashes, collapses newlines to spaces.
# ---------------------------------------------------------------------------
sanitise() {
  printf '%s' "$1" \
    | sed 's/["\]/'"'"'/g' \
    | tr '\n' ' ' \
    | sed 's/[[:space:]]*$//'
}

# ---------------------------------------------------------------------------
# Run format:check.
# ---------------------------------------------------------------------------
format_ok=true
format_output=""
if ! format_output=$(pnpm format:check 2>&1); then
  format_ok=false
fi

# ---------------------------------------------------------------------------
# Run lint.
# ---------------------------------------------------------------------------
lint_ok=true
lint_output=""
if ! lint_output=$(pnpm lint 2>&1); then
  lint_ok=false
fi

# ---------------------------------------------------------------------------
# Both passed — short success notice.
# ---------------------------------------------------------------------------
if $format_ok && $lint_ok; then
  printf '{"continue":true,"systemMessage":"CI gate passed (format:check + lint)."}'
  exit 0
fi

# ---------------------------------------------------------------------------
# At least one failed — build a combined message.
# ---------------------------------------------------------------------------
parts=()

if ! $format_ok; then
  # Grab just the [warn] lines listing offending files, limit to 10.
  summary=$(printf '%s' "$format_output" \
    | grep -E '^\[warn\]' | grep -v 'Code style issues' | head -10 \
    | sed 's/^\[warn\][[:space:]]*//' \
    | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  [[ -z "$summary" ]] && summary=$(sanitise "$(printf '%s' "$format_output" | head -5)")
  parts+=("format:check failed — ${summary}. Run: pnpm format")
fi

if ! $lint_ok; then
  summary=$(printf '%s' "$lint_output" \
    | grep -E 'error|warning' | head -10 \
    | sed 's/["\]/'"'"'/g' | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  [[ -z "$summary" ]] && summary=$(sanitise "$(printf '%s' "$lint_output" | head -5)")
  parts+=("lint failed — ${summary}. Run: pnpm lint")
fi

# Join parts with " | ".
message=$(printf '%s' "${parts[0]}")
for ((i=1; i<${#parts[@]}; i++)); do
  message="${message} | ${parts[$i]}"
done

printf '{"continue":true,"systemMessage":"CI gate issues found: %s"}' "$message"
