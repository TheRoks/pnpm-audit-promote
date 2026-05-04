import semver from 'semver';
import type { Logger } from '../logger.js';
import { getCatalogVersions } from '../catalog.js';

/**
 * Returns ` (MAJOR)` when `next` crosses a major boundary above `prior`,
 * else an empty string. Used to annotate log lines for visibility.
 */
export function majorBumpAnnotation(prior: string | undefined, next: string): string {
  if (!prior) return '';
  try {
    const a = semver.coerce(prior)?.version;
    const b = semver.coerce(next)?.version;
    if (a && b && semver.major(b) > semver.major(a)) return ' (MAJOR)';
  } catch {
    // ignore
  }
  return '';
}

/**
 * Emit `logger.warn` for every entry in `updates` that crosses a major
 * boundary above the value recorded in `priorVersions`.
 */
export function warnOnMajorPromotions(
  updates: ReadonlyMap<string, string>,
  priorVersions: ReadonlyMap<string, string>,
  logger: Logger,
): void {
  for (const [k, v] of updates) {
    const prior = priorVersions.get(k);
    if (!prior) continue;
    const a = semver.coerce(prior)?.version;
    const b = semver.coerce(v)?.version;
    if (a && b && semver.major(b) > semver.major(a)) {
      logger.warn(
        `Major bump promoted for ${k}: ${prior} -> ${v}. Review release notes for potential breaking changes.`,
      );
    }
  }
}

/** Convenience: read prior catalog versions and warn on majors in one call. */
export function reportPromotions(
  yaml: string,
  promotions: ReadonlyMap<string, string>,
  header: string,
  logger: Logger,
): void {
  const priorVersions = getCatalogVersions(yaml);
  logger.detail(header);
  for (const [k, v] of promotions) {
    const annotation = majorBumpAnnotation(priorVersions.get(k), v);
    logger.bullet(`${k} -> ${v}${annotation}`);
  }
  warnOnMajorPromotions(promotions, priorVersions, logger);
}
