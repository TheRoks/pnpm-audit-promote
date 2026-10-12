import semver from 'semver';
import type { PnpmCaptureRunner } from '../pnpm';

/** Fetch and cache registry publish timestamps; malformed/unavailable data is empty. */
export async function fetchPublishTimes(
  pnpm: PnpmCaptureRunner,
  packageName: string,
  cache: Map<string, Map<string, string>>,
): Promise<Map<string, string>> {
  const cached = cache.get(packageName);
  if (cached) return cached;
  const times = new Map<string, string>();
  try {
    const { stdout } = await pnpm.capture(['view', packageName, 'time', '--json']);
    const text = stdout.trim();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [version, iso] of Object.entries(parsed as Record<string, unknown>)) {
          if (version === 'created' || version === 'modified') continue;
          if (typeof iso === 'string' && semver.valid(version)) times.set(version, iso);
        }
      }
    }
  } catch {
    // Missing publish metadata remains an empty result for policy to handle.
  }
  cache.set(packageName, times);
  return times;
}
