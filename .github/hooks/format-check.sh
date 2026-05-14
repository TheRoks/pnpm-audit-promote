#!/usr/bin/env bash
# PostToolUse hook — runs pnpm format:check after any agent edit and surfaces
# formatting violations as a systemMessage so the agent can run pnpm format
# to auto-fix them.
#
# Only acts on file-editing tool calls (create_file, replace_string_in_file,
# edit_notebook_file, etc.). Skips non-relevant tools and generated/vendored
# paths to keep overhead low.
#
# Exit codes:
#   0 — continue (formatting passed, or file not relevant)
#   0 — continue with warning systemMessage (formatting failed — non-blocking)
#
# The hook never blocks the agent (exit 2). It surfaces the failure so the
# agent can call `pnpm format` to fix it.

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse the hook payload from stdin.
# Extract the tool name and the file path that was edited.
# ---------------------------------------------------------------------------
payload=$(node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(chunks.join(''));
    const toolName = data.tool_name ?? data.toolName ?? '';
    const inp = data.tool_input ?? data.toolInput ?? {};
    const filePath = inp.filePath ?? inp.file_path ?? inp.path ?? '';
    process.stdout.write(JSON.stringify({ toolName, filePath }));
  } catch {
    process.stdout.write(JSON.stringify({ toolName: '', filePath: '' }));
  }
});
")

tool_name=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).toolName)" -- "$payload")
file_path=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).filePath)" -- "$payload")

# ---------------------------------------------------------------------------
# Only act on file-editing tools.
# ---------------------------------------------------------------------------
case "$tool_name" in
  create_file|replace_string_in_file|multi_replace_string_in_file|edit_notebook_file)
    # Proceed to format check.
    ;;
  *)
    printf '{"continue":true}'
    exit 0
    ;;
esac

# ---------------------------------------------------------------------------
# Skip empty paths, generated files, and vendored/locked content.
# ---------------------------------------------------------------------------
if [[ -z "$file_path" ]]; then
  printf '{"continue":true}'
  exit 0
fi

if [[ "$file_path" =~ (dist/|node_modules/|pnpm-lock\.yaml$|\.min\.(js|css)$) ]]; then
  printf '{"continue":true}'
  exit 0
fi

# ---------------------------------------------------------------------------
# Skip file extensions that Prettier does not handle in this project.
# ---------------------------------------------------------------------------
if [[ ! "$file_path" =~ \.(ts|tsx|js|mjs|cjs|json|yaml|yml|md|mdx|css|html)$ ]]; then
  printf '{"continue":true}'
  exit 0
fi

# ---------------------------------------------------------------------------
# Run prettier --check on the specific file.
# If it fails, suggest pnpm format as the fix.
# ---------------------------------------------------------------------------
if output=$(pnpm exec prettier --check "$file_path" 2>&1); then
  printf '{"continue":true}'
else
  # Trim output for embedding in JSON.
  summary=$(printf '%s' "$output" | head -20 | tr '"' "'" | tr '\n' ' ')
  printf '{"continue":true,"systemMessage":"Prettier check failed for %s. Run pnpm format to auto-fix. Details: %s"}' \
    "$file_path" "$summary"
fi
