/**
 * PreToolUse hook — asks for confirmation before destructive shell commands.
 *
 * Reads the VS Code Copilot hook payload from stdin (JSON).
 * Emits permissionDecision:"ask" for dangerous patterns; "allow" otherwise.
 *
 * Triggered by: .github/hooks/destructive-guard.json
 */
import process from 'node:process';

/** @type {Array<{re: RegExp, label: string}>} */
const DESTRUCTIVE_PATTERNS = [
  // Recursive force delete — single flag cluster: -rf, -Rf, -rfv, -Rvf, -rRfFvv…
  // Lookaheads check that both r/R and f/F are present anywhere in the cluster.
  {
    re: /\brm\s+-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+/,
    label: 'rm -rf (recursive force delete)',
  },
  // Recursive force delete — separate flags in any order: rm -r -f, rm -f -r,
  // rm -r path -f, rm -F -r, etc. Two independent lookaheads verify that a
  // flag containing r/R and a flag containing f/F both appear after rm.
  // (?:\s+\S+)* is safe from ReDoS: \s+ and \S+ are disjoint, so each
  // iteration always consumes ≥2 chars with no ambiguous backtracking path.
  {
    re: /\brm\b(?=(?:\s+\S+)*\s+-[a-zA-Z]*[rR][a-zA-Z]*)(?=(?:\s+\S+)*\s+-[a-zA-Z]*[fF][a-zA-Z]*)/,
    label: 'rm -r ... -f (recursive force delete, separate flags)',
  },
  // Git history / remote mutations
  { re: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
  { re: /\bgit\s+push\s+(--force|-f)\b/, label: 'git push --force' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*\b/, label: 'git clean -f (removes untracked files)' },
  { re: /\bgit\s+commit\s+--amend\b/, label: 'git commit --amend (rewrites published history)' },
  { re: /\bgit\s+rebase\b(?!.*--(abort|continue|skip))/, label: 'git rebase (history rewriting)' },
  // SQL destructive statements
  { re: /\bdrop\s+(table|database|schema)\s/i, label: 'SQL DROP statement' },
  { re: /\btruncate\s+table\s/i, label: 'SQL TRUNCATE TABLE' },
];

/**
 * rm -rf on these well-known regenerable targets is considered safe.
 * Only skipped when the entire target list matches (not as a substring).
 */
const SAFE_RM_TARGETS = new Set([
  'node_modules',
  '.pnpm-store',
  'pnpm-lock.yaml',
  'dist',
  '.cache',
  'coverage',
  '.nyc_output',
  'tmp',
  'temp',
  'build',
]);

/** Tool names that execute shell commands. */
const SHELL_TOOLS = new Set(['run_in_terminal', 'execute', 'bash', 'shell', 'terminal']);

// ── Main ──────────────────────────────────────────────────────────────────────

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  /** @type {Record<string, unknown>} */
  let payload;
  try {
    payload = JSON.parse(chunks.join(''));
  } catch {
    // Malformed payload — allow and move on
    allow();
    return;
  }

  const toolName = String(payload.tool_name ?? payload.toolName ?? '').toLowerCase();
  const inp = /** @type {Record<string, string>} */ (payload.tool_input ?? payload.toolInput ?? {});
  const cmd = String(inp.command ?? inp.cmd ?? '').trim();

  // Only inspect tools that execute shell commands
  const isShellTool = [...SHELL_TOOLS].some((t) => toolName.includes(t));
  if (!isShellTool || !cmd) {
    allow();
    return;
  }

  const reason = firstDestructiveReason(cmd);
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `Destructive operation detected (${reason}) — please confirm this is intentional before proceeding.`,
        },
      }),
    );
  } else {
    allow();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

/**
 * Returns the human-readable label of the first destructive pattern found in
 * `cmd`, or `null` if the command is considered safe.
 *
 * @param {string} cmd
 * @returns {string | null}
 */
function firstDestructiveReason(cmd) {
  for (const { re, label } of DESTRUCTIVE_PATTERNS) {
    if (!re.test(cmd)) continue;

    // For rm -rf, skip if every target token is on the safe list
    if (label.startsWith('rm')) {
      const targets = extractRmTargets(cmd);
      if (targets.length > 0 && targets.every((t) => SAFE_RM_TARGETS.has(t))) continue;
    }

    return label;
  }
  return null;
}

/**
 * Extracts the path tokens after the rm flags.
 * e.g. "rm -rf node_modules dist" → ["node_modules", "dist"]
 *
 * @param {string} cmd
 * @returns {string[]}
 */
function extractRmTargets(cmd) {
  // Strip "rm" and any flag tokens (start with -)
  const tokens = cmd
    .split(/\s+/)
    .slice(1)
    .filter((t) => !t.startsWith('-'));
  // Normalize: take only the basename for matching
  return tokens.map((t) => t.replace(/\/$/, '').split('/').pop() ?? t);
}
