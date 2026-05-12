import { describe, it, expect } from 'vitest';
import {
  applyCatalogUpdates,
  collapseBlankLines,
  getCatalogNames,
  getCatalogVersions,
} from '../src/catalog';

const SAMPLE_LF = `packages:\n  - 'apps/*'\n\ncatalog:\n  react: '18.2.0'\n  '@scope/pkg': "1.0.0"\n  lodash: 4.17.21\n\noverrides:\n  semver: '^7.6.0'\n`;

const SAMPLE_CRLF = SAMPLE_LF.replace(/\n/g, '\r\n');

describe('getCatalogNames', () => {
  it('returns catalog package names (LF)', () => {
    const names = getCatalogNames(SAMPLE_LF);
    expect([...names].sort()).toEqual(['@scope/pkg', 'lodash', 'react'].sort());
  });

  it('returns catalog package names (CRLF)', () => {
    const names = getCatalogNames(SAMPLE_CRLF);
    expect(names.has('react')).toBe(true);
    expect(names.has('@scope/pkg')).toBe(true);
  });

  it('returns empty set when no catalog block', () => {
    expect(getCatalogNames('packages:\n  - apps/*\n').size).toBe(0);
  });
});

describe('applyCatalogUpdates', () => {
  it('updates a single catalog version preserving quoting style', () => {
    const out = applyCatalogUpdates(SAMPLE_LF, new Map([['react', '18.3.1']]));
    expect(out).toContain("react: '18.3.1'");
    expect(out).toContain('lodash: 4.17.21'); // unchanged, unquoted preserved
  });

  it('preserves CRLF line endings', () => {
    const out = applyCatalogUpdates(SAMPLE_CRLF, new Map([['react', '18.3.1']]));
    expect(out.includes('\r\n')).toBe(true);
    expect(out).toContain("react: '18.3.1'");
  });

  it('updates scoped package names', () => {
    const out = applyCatalogUpdates(SAMPLE_LF, new Map([['@scope/pkg', '2.0.0']]));
    expect(out).toContain(`'@scope/pkg': "2.0.0"`);
  });

  it('preserves single-quoted value style', () => {
    const out = applyCatalogUpdates(SAMPLE_LF, new Map([['react', '18.3.1']]));
    expect(out).toContain(`react: '18.3.1'`);
    expect(out).not.toContain(`react: "18.3.1"`);
  });

  it('preserves double-quoted value style', () => {
    const out = applyCatalogUpdates(SAMPLE_LF, new Map([['@scope/pkg', '1.2.3']]));
    expect(out).toContain(`'@scope/pkg': "1.2.3"`);
    expect(out).not.toContain(`'@scope/pkg': '1.2.3'`);
  });

  it('preserves unquoted value style', () => {
    const out = applyCatalogUpdates(SAMPLE_LF, new Map([['lodash', '4.17.22']]));
    expect(out).toContain('lodash: 4.17.22');
    expect(out).not.toContain(`lodash: '4.17.22'`);
    expect(out).not.toContain(`lodash: "4.17.22"`);
  });

  it('returns input unchanged when updates is empty', () => {
    expect(applyCatalogUpdates(SAMPLE_LF, new Map())).toBe(SAMPLE_LF);
  });

  it('returns input unchanged when no catalog block exists', () => {
    const yaml = "packages:\n  - 'apps/*'\n";
    expect(applyCatalogUpdates(yaml, new Map([['x', '1.0.0']]))).toBe(yaml);
  });

  it('does not swallow following lines (multiline regex bug guard)', () => {
    const out = applyCatalogUpdates(SAMPLE_LF, new Map([['react', '99.0.0']]));
    expect(out).toContain("'@scope/pkg'");
    expect(out).toContain('lodash');
    expect(out).toContain('overrides:');
  });
});

describe('collapseBlankLines', () => {
  it('collapses 3+ newlines to two', () => {
    expect(collapseBlankLines('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('preserves CRLF', () => {
    expect(collapseBlankLines('a\r\n\r\n\r\n\r\nb')).toBe('a\r\n\r\nb');
  });

  it('leaves two newlines alone', () => {
    expect(collapseBlankLines('a\n\nb')).toBe('a\n\nb');
  });
});

describe('AST-based catalog reads', () => {
  it('parses catalog entries with inline comments', () => {
    const yaml = "catalog:\n  react: '18.2.0' # pinned for compatibility\n  lodash: 4.17.21\n";
    const versions = getCatalogVersions(yaml);
    expect(versions.get('react')).toBe('18.2.0');
    expect(versions.get('lodash')).toBe('4.17.21');
  });

  it('parses catalog entries with anchors and aliases', () => {
    const yaml = "catalog:\n  react: &reactVer '18.2.0'\n  react-dom: *reactVer\n";
    const versions = getCatalogVersions(yaml);
    expect(versions.get('react')).toBe('18.2.0');
    // Aliased values should resolve to the same concrete version.
    expect(versions.get('react-dom')).toBe('18.2.0');
  });

  it('omits $ref placeholder values from getCatalogVersions but keeps names', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n  ghost: $package\n";
    expect(getCatalogNames(yaml).has('ghost')).toBe(true);
    expect(getCatalogVersions(yaml).has('ghost')).toBe(false);
  });

  it('returns empty results for unparseable yaml', () => {
    const yaml = 'catalog: { unterminated';
    expect(getCatalogNames(yaml).size).toBe(0);
    expect(getCatalogVersions(yaml).size).toBe(0);
  });

  it('returns empty results when catalog key is absent', () => {
    expect(getCatalogNames("packages:\n  - 'apps/*'\n").size).toBe(0);
  });

  it('reads entries from named maps under `catalogs:`', () => {
    const yaml =
      "catalogs:\n  default:\n    react: '18.2.0'\n  legacy:\n    react: '17.0.2'\n    lodash: 4.17.21\n";
    const names = getCatalogNames(yaml);
    expect(names.has('react')).toBe(true);
    expect(names.has('lodash')).toBe(true);
    const versions = getCatalogVersions(yaml);
    // `react` appears twice; the second occurrence wins (Map.set semantics).
    expect(versions.get('react')).toBe('17.0.2');
    expect(versions.get('lodash')).toBe('4.17.21');
  });
});

describe('AST-based catalog writes', () => {
  it('updates entries inside named maps under `catalogs:`', () => {
    const yaml = "catalogs:\n  default:\n    react: '18.2.0'\n  legacy:\n    lodash: 4.17.20\n";
    const out = applyCatalogUpdates(
      yaml,
      new Map([
        ['react', '18.3.1'],
        ['lodash', '4.17.21'],
      ]),
    );
    expect(out).toContain("react: '18.3.1'");
    expect(out).toContain('lodash: 4.17.21');
  });

  it('updates the canonical anchored value (alias resolves to the new version)', () => {
    const yaml = "catalog:\n  react: &reactVer '18.2.0'\n  react-dom: *reactVer\n";
    const out = applyCatalogUpdates(yaml, new Map([['react', '18.3.1']]));
    expect(out).toContain("'18.3.1'");
    // The alias is preserved; resolving the updated yaml yields the new version.
    expect(getCatalogVersions(out).get('react-dom')).toBe('18.3.1');
  });

  it('preserves inline comments on updated entries', () => {
    const yaml = "catalog:\n  react: '18.2.0' # pinned for compatibility\n";
    const out = applyCatalogUpdates(yaml, new Map([['react', '18.3.1']]));
    expect(out).toContain("react: '18.3.1'");
    expect(out).toContain('# pinned for compatibility');
  });

  it('preserves caret prefix on bumped versions', () => {
    const yaml = "catalog:\n  react: '^18.2.0'\n";
    const out = applyCatalogUpdates(yaml, new Map([['react', '18.3.1']]));
    expect(out).toContain("react: '^18.3.1'");
  });

  it('preserves tilde prefix on bumped versions', () => {
    const yaml = 'catalog:\n  lodash: ~4.17.20\n';
    const out = applyCatalogUpdates(yaml, new Map([['lodash', '4.17.21']]));
    expect(out).toContain('lodash: ~4.17.21');
  });

  it('leaves bare-pinned versions bare (no prefix injected)', () => {
    const yaml = 'catalog:\n  lodash: 4.17.20\n';
    const out = applyCatalogUpdates(yaml, new Map([['lodash', '4.17.21']]));
    expect(out).toContain('lodash: 4.17.21');
    expect(out).not.toContain('^4.17.21');
    expect(out).not.toContain('~4.17.21');
  });

  it('does not double-prefix when the incoming update already has a prefix', () => {
    const yaml = "catalog:\n  react: '^18.2.0'\n";
    const out = applyCatalogUpdates(yaml, new Map([['react', '^19.0.0']]));
    expect(out).toContain("react: '^19.0.0'");
    expect(out).not.toContain('^^');
  });
});
