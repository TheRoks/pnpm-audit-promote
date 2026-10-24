# Refresh Process Sequence

`runRefresh` owns the order of the refresh phases. Program-initiated file
changes use `WorkspaceMutations`; pnpm commands remain external process effects
and are reconciled with the desired workspace YAML snapshot after each call.

```mermaid
sequenceDiagram
    actor User
    participant CLI as cli.ts
    participant Refresh as runRefresh()
    participant State as WorkspaceState
    participant Files as WorkspaceMutations
    participant Pnpm as PnpmRunner
    participant Cleanup as cleanup phase
    participant Audit as audit phases
    participant Summary as summary

    User->>CLI: pnpm-audit-promote [options]
    CLI->>Refresh: refreshDeps(options)
    Refresh->>State: discover workspace and YAML snapshot
    Refresh->>Pnpm: resolve target pnpm version
    Pnpm-->>Refresh: version and capabilities
    Refresh->>User: request destructive-action confirmation
    alt user declines
        Refresh-->>CLI: canceled RefreshResult
    else confirmed
        Refresh->>Files: snapshot lock, workspace YAML, and scoped package.json files
        opt audit enabled
            Refresh->>Pnpm: pnpm audit --json (pre-cleanup baseline)
            Pnpm-->>Refresh: initial advisory snapshot
        end

        rect rgba(100, 160, 240, 0.15)
            Refresh->>Cleanup: remove lockfile, node_modules, and existing overrides
            Cleanup->>Files: guarded removals and package.json edits
        end

        rect rgba(80, 200, 120, 0.15)
            Refresh->>Pnpm: pnpm install --no-frozen-lockfile
            Pnpm-->>State: workspace YAML may be normalized
            Refresh->>State: reconcile YAML and preserve build approvals
            opt explicit dedupe needed
                Refresh->>Pnpm: pnpm dedupe
                Pnpm-->>State: workspace YAML may be normalized
                Refresh->>State: reconcile desired YAML
            end
        end

        opt audit enabled
            rect rgba(230, 170, 50, 0.15)
                Refresh->>Audit: post-cleanup audit and direct-dependency plan
                Audit->>Files: apply catalog and package.json updates
                opt direct dependencies changed
                    Audit->>Pnpm: pnpm install --no-frozen-lockfile
                    Pnpm-->>State: workspace YAML may be normalized
                    Audit->>State: reconcile desired YAML
                end
                Audit->>Pnpm: pnpm audit --fix
                Pnpm-->>State: audit overrides and pnpm settings
                Audit->>Audit: validate availability and release age
                Audit->>Audit: promote catalog-eligible overrides
                opt --ignore-workspace
                    Audit->>Files: migrate overrides into root package.json
                end
                Audit->>Pnpm: post-audit install and optional dedupe
                Pnpm-->>State: final dependency graph
                Audit-->>Refresh: direct changes and blocked overrides
            end
        end

        Refresh->>Summary: capture final state and audit status
        Summary-->>Refresh: RunSummaryData and RefreshResult
        opt summary output enabled
            Refresh->>Summary: render terminal and optional summary file
        end

        alt a phase throws
            Refresh->>Files: restore original lock, workspace YAML, and scoped manifests
            Files-->>Refresh: retain explicit pnpm approve-builds decisions
            Refresh-->>CLI: rethrow original failure with recovery guidance
        end
    end
```

Failure recovery restores the lockfile, workspace YAML, and in-scope package
manifests. It retains build-script decisions recorded through the interactive
`pnpm approve-builds` flow. `node_modules` is not restored; the failure message
asks the user to run `pnpm install` before resuming work.
