---
goal: Refactor refresh orchestration and core modules around cohesive responsibilities
version: 1
date_created: 2026-10-12
owner: pnpm-audit-promote maintainers
status: Completed
tags: [refactor, architecture, solid]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan reduces the responsibilities and dependency reach of `src/refresh.ts` and the surrounding core modules while preserving the public `refreshDeps(options)` API and its existing pnpm, safety, audit, and summary behavior. The target separates application sequencing, workspace state, pnpm process execution, audit decisions, document edits, and summary presentation. It applies SOLID where a real change boundary exists and avoids adding interfaces or modules solely to satisfy a principle.

The intended dependency direction is: the public API calls the refresh application flow; the flow coordinates phase operations; audit and catalog rules produce decisions and document changes; workspace, pnpm, filesystem, prompting, and summary output modules perform boundary work. Audit code will not depend on summary code, and pnpm process details will not leak into refresh phases.

## 1. Requirements & Constraints

- **REQ-001**: `src/refresh.ts` SHALL continue to export `refreshDeps`, `RefreshOptions`, `RefreshResult`, and `AuditFixMode` with compatible behavior and signatures.
- **REQ-002**: The refresh flow SHALL preserve the current phase order, including capturing the initial audit and workspace snapshots before cleanup.
- **REQ-003**: Dry-run, confirmation cancellation, `--ignore-workspace`, pnpm build approval, workspace YAML restoration, audit-ignore pruning, release-age preservation, and audit failure handling SHALL retain their current externally observable behavior.
- **REQ-004**: pnpm 10, 11, and 12 behavior SHALL remain covered, including audit fix arguments, automatic dedupe, workspace file normalization, and supported build-script decisions.
- **REQ-005**: Every added or changed test title SHALL use the repository's `REQ-AREA-NNN` traceability format; plan-local identifiers in this document are not test requirement IDs.
- **REQ-006**: Audit and promotion decisions SHALL not import from the summary subsystem.
- **REQ-007**: Each module SHALL expose the smallest useful API for its callers; new interfaces SHALL be added only at a genuine substitution or testing boundary.
- **REQ-008**: The refactor SHALL preserve the existing public dependency injection points for `Logger`, `PnpmRunner`, and `ConfirmFn`; it SHALL NOT add a general-purpose dependency container or filesystem port without a demonstrated second implementation.
- **CON-001**: Preserve unrelated staged, unstaged, and untracked workspace changes while implementing this plan.
- **CON-002**: Keep ESM imports extensionless in TypeScript source and satisfy strict TypeScript settings.
- **CON-003**: Keep audit policy decisions deterministic and testable without invoking a real pnpm process; real pnpm integration tests remain gated by `RUN_INTEGRATION=1`.
- **GUD-001**: Extract cohesive phase operations from `src/refresh.ts`; do not split functions merely to reduce line count.
- **GUD-002**: Preserve stable module facades while moving callers in small, reviewable steps; remove compatibility re-exports only after all internal callers have migrated.
- **PAT-001**: Put policy and transformation logic in pure functions where practical; keep logging, process execution, and file writes at application or adapter boundaries.
- **PAT-002**: Apply Single Responsibility by grouping code around one reason to change; apply Open/Closed through explicit policies and decisions rather than adding more branches to the top-level flow.
- **PAT-003**: Apply Interface Segregation by typing consumers against only the pnpm capabilities they use, while retaining `PnpmRunner` as the public composite contract when useful.
- **PAT-004**: Apply Dependency Inversion at variable external boundaries; use the existing runner, logger, and confirmation seams rather than introducing a generic service locator.
- **PAT-005**: Apply Liskov Substitution by keeping real and test `PnpmRunner` implementations consistent with the documented result, failure, and optional-interactive-command semantics.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Characterize the current refresh contract and identify regression coverage before moving responsibilities.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                               | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Review `src/refresh.ts:181` (`refreshDeps`), `prepareRun` (`:270`), `captureInitialState` (`:373`), `runCleanupPhase` (`:431`), `runInstallAndDedupe` (`:441`), `runAuditPhase` (`:463`), `runAndRestore` (`:566`), `reconcileAfterAuditRead` (`:608`), `preAuditCatalogBump` (`:616`), and `auditFix` (`:688`). Record each phase's inputs, outputs, writes, pnpm calls, and failure behavior in the phase test descriptions in `tests/refresh.test.ts`. | ✅        | 2026-10-12 |
| TASK-002 | Add or tighten focused tests in `tests/refresh.test.ts` for prompt-before-cleanup, pre-cleanup audit capture, install/audit ordering, workspace YAML restoration after pnpm, dry-run writes and commands, audit failure, `ignoreWorkspace`, and interactive `approve-builds` recovery. Reuse existing cases where they already assert the contract; do not duplicate them.                                                                                | ✅        | 2026-10-12 |
| TASK-003 | Add contract cases in `tests/pnpm.test.ts` for the `PnpmRunner` semantics used by refresh: thrown command failures, non-throwing audit exit codes, captured stdout, version caching, extra args, and optional interactive execution. Prefix each test with the matching existing requirement ID.                                                                                                                                                          | ✅        | 2026-10-12 |

### Implementation Phase 2

- GOAL-002: Reduce the public `src/refresh.ts` module to a stable facade and move orchestration details into cohesive application modules.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                    | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-004 | Create `src/refresh/types.ts` for `RefreshOptions`, `RefreshResult`, and `AuditFixMode`; keep their comments and exported types intact. Update `src/refresh.ts` to re-export these types and retain `refreshDeps(options)` as the public wrapper.                                                                                                                                                                              | ✅        | 2026-10-12 |
| TASK-005 | Create `src/refresh/prepare.ts` and move `PreparedRun` plus `prepareRun()` option defaults, option validation, workspace initialization, pnpm runner construction, pnpm version detection, and progress setup into it. Return an explicit prepared-run value; do not add a mutable catch-all context.                                                                                                                          | ✅        | 2026-10-12 |
| TASK-006 | Create `src/refresh/initialState.ts` and move `InitialState`, `captureInitialState()`, and package-name parsing out of `src/refresh.ts`. Keep the original catalog, override, lockfile, advisory, audit JSON, and baseline-safe-version snapshots together because they describe one run baseline.                                                                                                                             | ✅        | 2026-10-12 |
| TASK-007 | Create `src/refresh/commands.ts` for `runAndRestore()` and `reconcileAfterAuditRead()`. Keep the ignored-build recovery, `approve-builds` call, preservation of build decisions, and post-command workspace restoration in this boundary module. It may depend on `PnpmRunner`, `WorkspaceState`, and `Logger`, but phase modules SHALL call its operation rather than implement restoration themselves.                       | ✅        | 2026-10-12 |
| TASK-008 | Create `src/refresh/install.ts` for `runInstallAndDedupe()` and keep the shared `INSTALL_ARGS` command invariant in `src/refresh/commands.ts`. Keep install and dedupe selection together because the decision depends on the same workspace pnpm version and `autoDedupe` setting. Delegate command execution to `src/refresh/commands.ts`.                                                                                   | ✅        | 2026-10-12 |
| TASK-009 | Create `src/refresh/auditPhase.ts` and move `runAuditPhase()`, `preAuditCatalogBump()`, and `auditFix()` there. Keep direct dependency planning, audit-fix invocation, override reconciliation, release-age checks, and post-audit reinstall as one application phase; return explicit package changes and blocked overrides to the coordinator.                                                                               | ✅        | 2026-10-12 |
| TASK-010 | Create `src/refresh/runRefresh.ts` containing only the phase sequence, confirmation decision, result assembly, summary rendering, and elapsed-time reporting. It SHALL call the extracted operations through explicit arguments and SHALL NOT contain YAML parsing, pnpm spawn recovery, package JSON traversal, or catalog policy logic. Update `src/refresh.ts` so its implementation is a small delegation to `runRefresh`. | ✅        | 2026-10-12 |
| TASK-011 | Move or update `tests/refresh.test.ts` only where needed to test the public flow through `refreshDeps`; add `tests/refresh/*.test.ts` for extracted modules when the behavior can be isolated at their module APIs. Keep all test names traceable.                                                                                                                                                                             | ✅        | 2026-10-12 |

### Implementation Phase 3

- GOAL-003: Split workspace discovery, package scope, and YAML snapshot lifecycle so `WorkspaceState` no longer owns unrelated workspace concerns.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-012 | Create `src/workspace/discovery.ts` and move root identification, pnpm workspace signal checks, enclosing-workspace detection, and package-manager version extraction from `src/workspace.ts` (`WorkspaceState.initialize`, `findEnclosingPnpmWorkspaceYaml`, and `detectWorkspacePnpm*`). Return a workspace identity containing resolved root and pnpm metadata without reading or editing the YAML snapshot.                                                                        | ✅        | 2026-10-12 |
| TASK-013 | Create `src/workspace/yamlSnapshot.ts` for YAML file paths, EOL handling, original/desired snapshots, read/write, restore, and pnpm-produced setting reconciliation currently implemented by `WorkspaceState` methods `detectEol`, `readWorkspaceYaml`, `saveWorkspaceYaml`, `refreshHasWorkspaceYaml`, `resetMinimumReleaseAgeExclude`, `preserveAuditIgnorePrune`, `preserveApprovedBuilds`, and `restoreWorkspaceYaml`. Keep filesystem writes and dry-run checks in this boundary. | ✅        | 2026-10-12 |
| TASK-014 | Create `src/workspace/packageScope.ts` and move workspace package glob extraction and `resolveWorkspacePackageDirs()` from `src/workspace.ts`. Keep package discovery independent of YAML snapshot mutation so cleanup and direct-dependency code can consume package scope without depending on lifecycle behavior.                                                                                                                                                                   | ✅        | 2026-10-12 |
| TASK-015 | Refactor `WorkspaceState` into a narrow per-run aggregate in `src/workspace.ts` that composes the discovered identity, package scope, and YAML snapshot. Migrate `src/cleanup.ts`, `src/refresh/prepare.ts`, `src/refresh/commands.ts`, and `src/audit/*.ts` to the narrowest component they need; then remove temporary compatibility exports that have no callers.                                                                                                                   | ✅        | 2026-10-12 |
| TASK-016 | Update `tests/workspace.test.ts` to test root discovery, package scope, and YAML snapshot behavior at their public module seams. Retain coverage for EOL preservation, dry-run writes, pnpm-created YAML, approved build settings, pnpm 12 audit-ignore pruning, and minimum-release-age excludes.                                                                                                                                                                                     | ✅        | 2026-10-12 |

### Implementation Phase 4

- GOAL-004: Correct dependency direction between audit, workspace document handling, cleanup, and summary modules.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-017 | Create `src/workspaceOverrides.ts` for shared readers of workspace YAML overrides and package.json `pnpm.overrides`. Move `readWorkspaceOverrides()` and `readPackageJsonOverrides()` from `src/summary/collect.ts`; update `src/audit/ignoreWorkspaceMigration.ts`, `tests/audit/ignoreWorkspaceMigration.test.ts`, and summary callers so audit code no longer imports from `summary/collect.ts`.                                                                                                                                                                               | ✅        | 2026-10-12 |
| TASK-018 | Create `src/workspaceYaml.ts` for generic YAML document parsing, serialization, EOL-preserving edits, blank-line collapse, and audit-ignore pruning helpers currently mixed into `src/catalog.ts`. Keep catalog-specific selectors and update rules in `src/catalog.ts`; update `src/workspace.ts`, `src/cleanup.ts`, and audit callers to use the document boundary.                                                                                                                                                                                                             | ✅        | 2026-10-12 |
| TASK-019 | Split `src/cleanup.ts` by reason to change: keep filesystem deletion and workspace containment checks in `src/cleanup/files.ts`; move stripping workspace and package.json overrides into `src/cleanup/overrides.ts`, using the shared document/JSON edit functions. Keep an exported `src/cleanup.ts` facade only if needed to avoid a noisy all-at-once caller migration; update `tests/cleanup.test.ts`.                                                                                                                                                                       | ✅        | 2026-10-12 |
| TASK-020 | Refactor `src/audit/parseAdvisories.ts` and `src/audit/bumpPackageJsonDeps.ts` to separate pnpm version acquisition from deterministic planning (`planCatalogBumps` and `planPackageJsonBumps`), then apply returned change sets in the application layer. Preserve severity thresholds, ignored advisory handling, major-bump policy, and package range behavior; update `tests/audit/parseAdvisories.test.ts` and `tests/audit/bumpPackageJsonDeps.test.ts`.                                                                                                                    | ✅        | 2026-10-12 |
| TASK-021 | Refactor `guardWorkspaceOverrideAvailability()`, `syncAuditOverridesIntoCatalog()`, and `syncPackageJsonOverridesIntoCatalog()` in `src/audit/promoteWorkspaceOverrides.ts` and `src/audit/promotePackageJsonOverrides.ts` to consume explicit document and baseline inputs, return typed decisions/change sets, and leave YAML/package.json writes and logging to the application boundary. Keep registry lookups separate from compatibility and promotion decisions. Preserve safe-floor selection and original override-range behavior; update `tests/audit/promote.test.ts`. | ✅        | 2026-10-12 |
| TASK-022 | Split `src/audit/releaseAge.ts` by policy and external data access: keep configuration parsing, exclusions, and age predicates in `src/audit/releaseAgePolicy.ts`; move publish-time lookup to `src/audit/releaseAgeRegistry.ts` using the narrow pnpm capture capability; have the audit phase apply blocked-override decisions. Preserve the current release-age rules and blocked-override reporting; update `tests/audit/releaseAge.test.ts`.                                                                                                                                 | ✅        | 2026-10-12 |
| TASK-023 | Update `src/summary/collect.ts` and `src/summary/emit.ts` so collection consumes explicit snapshots/change sets and file reads remain at the summary boundary. Keep `src/summary/render.ts` as a cohesive renderer and ensure the summary subsystem has no imports from refresh orchestration or audit policy modules; update `tests/summary.test.ts` and `tests/summary.emit.test.ts`.                                                                                                                                                                                           | ✅        | 2026-10-12 |

### Implementation Phase 5

- GOAL-005: Narrow external capability contracts, enforce dependency direction, and validate the complete refactor.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-024 | Review `PnpmRunner` in `src/pnpm.ts` against actual consumers. Define narrow capability types for command execution, captured output, version lookup, and interactive execution only where a consumer genuinely uses a strict subset; retain `PnpmRunner` as the composite public injection contract and have `createPnpmRunner()` satisfy those capabilities. Keep `runWithProgress`, spinner rendering, executable resolution, and `spawnPnpm()` inside the pnpm adapter boundary. | ✅        | 2026-10-12 |
| TASK-025 | Add targeted ESLint `no-restricted-imports` boundaries in `eslint.config.mjs` for forbidden dependency directions established by this refactor, including audit-to-summary and domain-to-refresh imports. Do not add a dependency-graph package unless ESLint cannot enforce the required boundaries.                                                                                                                                                                                | ✅        | 2026-10-12 |
| TASK-026 | Run `pnpm traceability` and `pnpm traceability:strict`; update `REQUIREMENTS.md` only if implementation changes a user-visible behavior, not for module movement alone.                                                                                                                                                                                                                                                                                                              | ✅        | 2026-10-12 |
| TASK-027 | Run the required CI gate `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, then run `pnpm test:integration` for the existing real-pnpm fixture coverage. Inspect the final diff to verify public exports, tests, generated traceability, and unrelated work are preserved.                                                                                                                                                                                                   | ✅        | 2026-10-12 |

### Follow-up implementation

The implementation also tightened state and audit-data boundaries discovered during the refactor:

- `WorkspaceYamlSnapshot` now exposes separate adopt and write transitions so callers cannot update the desired YAML and persist it as unrelated operations.
- A normalized pnpm audit result is parsed once per refresh phase and reused by baseline, catalog-bump, package-bump, and summary logic.
- Audit helpers accept narrower YAML snapshot, package-scope, and manifest inputs instead of the full workspace aggregate where they need only a subset.
- Workspace pnpm major and exact version are read from one package manifest parse.
- Focused tests cover YAML transitions, audit snapshot reuse, refresh phase behavior, and the combined pnpm pin read.
- The full local CI gate, formatting, strict traceability, and real-pnpm integration scenarios passed. The integration suite passed its two matching cases separately on pnpm 10, 11, and 12.

## 3. Alternatives

- **ALT-001**: Rewrite the tool into a generic Clean Architecture/hexagonal framework with ports for every filesystem, clock, logger, prompt, and package manager operation. Rejected because most ports would have one implementation, add indirection, and increase maintenance without giving current callers meaningful substitution.
- **ALT-002**: Keep the current modules and only split `refresh.ts` by line count. Rejected because the existing dependency inversion issue (`audit/ignoreWorkspaceMigration.ts` importing `summary/collect.ts`) and `WorkspaceState` ownership of discovery, package scope, and YAML lifecycle would remain.
- **ALT-003**: Replace `WorkspaceState` with immutable snapshots in one change. Rejected because the current flow intentionally reconciles pnpm's mid-run YAML edits and preserves selected user decisions; a staged migration allows those state transitions to remain testable.

## 4. Dependencies

- **DEP-001**: Existing `PnpmRunner`, `Logger`, and `ConfirmFn` injection points in `src/pnpm.ts`, `src/logger.ts`, and `src/prompt.ts` provide the initial external seams.
- **DEP-002**: `tests/helpers/recordingRunner.ts` and the temporary-filesystem test helpers provide deterministic regression coverage during extraction.
- **DEP-003**: Existing `REQUIREMENTS.md` IDs and `scripts/check-traceability.mjs` define the test naming and traceability gate.
- **DEP-004**: Existing TypeScript, ESLint, Vitest, and pnpm configuration; this plan adds no runtime dependency.

## 5. Files

- **FILE-001**: `src/refresh.ts` — stable public facade for refresh types and `refreshDeps`.
- **FILE-002**: `src/refresh/types.ts`, `src/refresh/prepare.ts`, `src/refresh/initialState.ts`, `src/refresh/commands.ts`, `src/refresh/install.ts`, `src/refresh/auditPhase.ts`, and `src/refresh/runRefresh.ts` — application-level preparation, baseline capture, command reconciliation, install, audit, and sequencing.
- **FILE-003**: `src/workspace.ts`, `src/workspace/discovery.ts`, `src/workspace/yamlSnapshot.ts`, and `src/workspace/packageScope.ts` — workspace identity, YAML lifecycle, and package scope.
- **FILE-004**: `src/workspaceYaml.ts`, `src/workspaceOverrides.ts`, and `src/catalog.ts` — YAML document mechanics, shared override access, and catalog policy.
- **FILE-005**: `src/cleanup.ts`, `src/cleanup/files.ts`, and `src/cleanup/overrides.ts` — cleanup facade and separate filesystem/manifest operations.
- **FILE-006**: `src/audit/*.ts`, including `src/audit/releaseAgePolicy.ts`, `src/audit/releaseAgeRegistry.ts`, `src/audit/overrideAvailabilityPolicy.ts`, `src/audit/workspaceOverridePromotionPolicy.ts`, and `src/audit/packageJsonOverridePromotionPolicy.ts` — audit policy decisions, pnpm-backed metadata reads, and change application boundaries.
- **FILE-007**: `src/pnpm.ts` and `eslint.config.mjs` — pnpm adapter capabilities and dependency direction rules.
- **FILE-008**: `src/summary/collect.ts`, `src/summary/emit.ts`, and `src/summary/render.ts` — summary input collection, output side effects, and rendering.
- **FILE-009**: `tests/refresh.test.ts`, `tests/refresh/*.test.ts`, `tests/workspace.test.ts`, `tests/pnpm.test.ts`, and `tests/audit/*.test.ts` — phase contracts and regression behavior.
- **FILE-010**: `REQUIREMENTS.md` and `docs/traceability.md` — update only if behavior changes or traceability output changes.

## 6. Testing

- **TEST-001**: Public-flow regression tests in `tests/refresh.test.ts` SHALL verify phase order, initial state capture, cancellation, dry-run behavior, command failures, and final result construction through `refreshDeps()`.
- **TEST-002**: Extracted refresh phase tests in `tests/refresh/*.test.ts` SHALL verify explicit input/output contracts without shelling out to pnpm.
- **TEST-003**: Workspace tests SHALL cover discovery, scope resolution, snapshot restore/reconciliation, EOL handling, dry-run behavior, and pnpm-created YAML.
- **TEST-004**: Audit tests SHALL prove existing version floor, vulnerability, release-age, override promotion, and advisory selection behavior remains unchanged after policy/application separation.
- **TEST-005**: Runner tests SHALL verify each narrow capability against both `createPnpmRunner()` behavior and `tests/helpers/recordingRunner.ts` where applicable.
- **TEST-006**: Architecture lint rules SHALL fail if audit imports summary modules or audit/domain modules import the refresh application layer.
- **TEST-007**: Required local validation SHALL pass: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm traceability:strict`, and `pnpm test:integration`.

## 7. Risks & Assumptions

- **RISK-001**: Moving stateful YAML reconciliation can change when pnpm-generated settings are adopted or discarded. Mitigation: move the existing behavior as a unit first, with tests for every reconciliation path before changing ownership.
- **RISK-002**: Reworking audit functions into decision and application steps can accidentally change logs, mutation order, or error propagation. Mitigation: preserve current policy tests and compare before/after run summaries and command sequences using the recording runner.
- **RISK-003**: Broad caller migration may create temporary duplicate APIs. Mitigation: keep compatibility facades only within the phase that needs them and remove them before the final validation phase.
- **ASSUMPTION-001**: The public `refreshDeps` API and documented pnpm behavior are compatibility contracts; internal file paths and private function signatures may change.
- **ASSUMPTION-002**: The currently staged and unstaged dependency-audit fixes are part of the baseline for this plan and are not to be reverted or rewritten as architectural cleanup unless a task directly requires it.
- **ASSUMPTION-003**: The goal is a staged refactor that improves cohesion and dependency direction, not a wholesale rewrite or a prescribed class-per-SOLID-principle design.

## 8. Related Specifications / Further Reading

- [AGENTS.md](../AGENTS.md)
- [REQUIREMENTS.md](../REQUIREMENTS.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)
