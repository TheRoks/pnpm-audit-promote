import type { PnpmCaptureRunner } from '../pnpm';

/**
 * Fetch registry version metadata through the narrow output-capture capability.
 * Both lookups cache their results per planning operation and treat network or
 * response failures as unavailable metadata.
 */
export async function getAvailableVersions(
  pnpm: PnpmCaptureRunner,
  packageName: string,
  cache: Map<string, string[]>,
): Promise<string[]> {
  const cached = cache.get(packageName);
  if (cached) return cached;
  let versions: string[] = [];
  try {
    const { stdout } = await pnpm.capture(['view', packageName, 'versions', '--json']);
    const text = stdout.trim();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        versions = parsed.filter((version): version is string => typeof version === 'string');
      } else if (typeof parsed === 'string') {
        versions = [parsed];
      }
    }
  } catch {
    versions = [];
  }
  cache.set(packageName, versions);
  return versions;
}
