/**
 * Read the `overrides:` block from a workspace yaml string and return a
 * `selector -> value` map.
 */
export function readWorkspaceOverrides(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const blockRe = /^(overrides:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;
  const m = blockRe.exec(yaml);
  if (!m) return out;
  const body = m[2] ?? '';
  const entryRe =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^'"\r\n]+?))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s]+))\s*$/;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const em = entryRe.exec(line);
    if (!em) continue;
    const key = em[1] ?? em[2] ?? em[3] ?? '';
    const val = em[4] ?? em[5] ?? em[6] ?? '';
    if (key) out.set(key, val);
  }
  return out;
}

/** Read `pnpm.overrides` from a package.json text. Tolerant of malformed input. */
export function readPackageJsonOverrides(jsonText: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = JSON.parse(jsonText) as { pnpm?: { overrides?: Record<string, unknown> } };
    const overrides = parsed?.pnpm?.overrides;
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === 'string') out.set(k, v);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/** Combine workspace and package.json overrides into one selector-keyed map. */
export function readAllOverrides(
  workspaceYaml: string,
  rootPackageJsonText: string | null,
): Map<string, { value: string; source: 'workspace' | 'package.json' }> {
  const out = new Map<string, { value: string; source: 'workspace' | 'package.json' }>();
  for (const [key, value] of readWorkspaceOverrides(workspaceYaml)) {
    out.set(key, { value, source: 'workspace' });
  }
  if (rootPackageJsonText) {
    for (const [key, value] of readPackageJsonOverrides(rootPackageJsonText)) {
      // package.json takes precedence in display when keys collide.
      out.set(key, { value, source: 'package.json' });
    }
  }
  return out;
}
