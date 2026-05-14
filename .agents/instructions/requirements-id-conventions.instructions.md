---
description: 'Use when writing or editing REQUIREMENTS.md: enforces REQ-AREA-NNN ID format, SHALL statement style, deprecation policy, and test-traceability conventions for pnpm-audit-promote.'
applyTo: '**/REQUIREMENTS.md'
---

# Requirements ID Conventions

## ID format

Every requirement MUST carry a stable ID of the form `REQ-<AREA>-<NNN>`:

- `<AREA>` is an uppercase ASCII word matching one of the defined sections (see below).
- `<NNN>` is a zero-padded three-digit integer, starting at `001` per area.
- IDs MUST be unique across the entire file.
- A deleted ID MUST NOT be re-used. Mark it `(deprecated)` and leave it in place.

### Defined areas (extend this list when adding a new section)

| Area token    | Section heading                        |
| ------------- | -------------------------------------- |
| `CORE`        | refresh orchestration                  |
| `WORKSPACE`   | root detection and scope               |
| `SAFETY`      | destructive-action guards              |
| `CATALOG`     | pnpm-workspace.yaml manipulation       |
| `OVERRIDES`   | promotion logic                        |
| `AUDIT`       | direct-dep handling and bump selection |
| `PNPM10`      | pnpm 10 specific behavior              |
| `PNPM11`      | pnpm 11 specific behavior              |
| `SUMMARY`     | run summary output                     |
| `CLI`         | command-line interface                 |
| `LOGGING`     | log levels and formatting              |
| `PORTABILITY` | cross-platform behavior                |
| `ERRORS`      | typed error contract                   |
| `PNPM-RUNNER` | runner abstraction                     |
| `INVARIANT`   | idempotency                            |
| `INTEGRATION` | end-to-end scenarios (real pnpm)       |

When adding a new area, add a `## <AREA> — <description>` section heading AND a row in this table.

## SHALL statement rules

- Every normative statement MUST use SHALL (obligation) or SHALL NOT (prohibition).
- Do NOT use "should", "must", "will", or "may" for normative behavior.
- One primary observable behavior per requirement; use sub-bullets for enumerated values only.
- Separate rationale from the normative statement using an `_Rationale: …_` italic suffix or a `_Note: …_` annotation.

## Markdown layout

```markdown
- **REQ-AREA-NNN** — <concise SHALL statement>.
  _Rationale: optional explanation of why, not what._
```

- Bold the ID with `**REQ-AREA-NNN**`.
- Em-dash (`—`) between ID and statement, with spaces on both sides.
- Rationale on the next line, indented two spaces, italic.
- Deprecated requirement: append `(deprecated)` after the ID, keep the body.

## Test traceability

Every `it()` or `test()` title in `tests/**/*.test.ts` that covers a requirement MUST be
prefixed with the matching ID(s):

```ts
it('REQ-CORE-003: re-applies workspace snapshot after pnpm invocation', ...);
it('REQ-AUDIT-001 REQ-AUDIT-002: bumps direct dep and removes override', ...);
```

Run `pnpm traceability` to regenerate `docs/traceability.md`.
Run `pnpm traceability:strict` (CI gate) to fail on unbound requirements.

## Checklist when adding a requirement

1. Pick the next unused `NNN` in the area (check the highest existing ID + 1).
2. Write a single SHALL statement for one externally observable behavior.
3. If rationale is needed, add it as `_Rationale: …_`, not inline.
4. Add at least one test whose title starts with the new ID.
5. Run `pnpm traceability:strict` locally before committing.

## Checklist when deprecating a requirement

1. Replace `**REQ-AREA-NNN**` with `**REQ-AREA-NNN** (deprecated)`.
2. Keep the body text in place.
3. Remove any `it()` prefixes that reference only this ID (or update them if behavior moved to a new ID).
4. Run `pnpm traceability:strict` to confirm no orphaned test references remain.
