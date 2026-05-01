# Commit Classification Heuristics

> **Role in the workflow:** Commit messages are a _secondary_ signal. The code diff
> is always read first and treated as ground truth. Use these heuristics to add
> intent and context on top of what the diff already shows — not to replace it.
> When a commit message contradicts the diff, trust the diff.

When reading `git log` output, map each commit to one of the categories below.
Repos that follow Conventional Commits (https://www.conventionalcommits.org/) will
have explicit prefixes — use them directly. For freeform commit messages, use the
heuristics.

---

## Conventional Commit prefixes → category

| Prefix                                                        | Category                     |
| ------------------------------------------------------------- | ---------------------------- |
| `feat:` / `feat(scope):`                                      | feat                         |
| `fix:` / `fix(scope):`                                        | fix                          |
| `perf:`                                                       | perf                         |
| `refactor:`                                                   | refactor                     |
| `docs:`                                                       | docs                         |
| `chore:`                                                      | chore                        |
| `test:` / `tests:`                                            | test                         |
| `ci:`                                                         | chore                        |
| `build:`                                                      | chore                        |
| `style:`                                                      | chore                        |
| `revert:`                                                     | depends on what was reverted |
| `BREAKING CHANGE` in footer or `!` after type (e.g. `feat!:`) | breaking                     |

---

## Freeform commit message heuristics

**Breaking:**

- Contains words: _breaking_, _incompatible_, _remove_, _rename_, _drop support_
- Phrase patterns: _no longer_, _was removed_, _has been deleted_, _breaking change_

**Feat (new feature):**

- Starts with: _add_, _implement_, _introduce_, _support_, _new_
- Contains: _now supports_, _ability to_, _can now_

**Fix:**

- Starts with: _fix_, _patch_, _resolve_, _correct_, _handle_
- Contains: _bug_, _regression_, _crash_, _error_, _wrong_, _incorrect_, _broken_

**Perf:**

- Contains: _speed up_, _faster_, _reduce memory_, _optimize_, _performance_

**Refactor:**

- Contains: _refactor_, _clean up_, _reorganize_, _restructure_, _simplify_, _extract_

**Docs:**

- Contains: _docs_, _readme_, _comment_, _example_, _typo_

**Chore:**

- Contains: _bump_, _upgrade dependencies_, _update deps_, _version bump_, _ci_, _lint_

**Test:**

- Contains: _test_, _spec_, _coverage_, _fixture_

---

## Classifying merge commits

Merge commits (e.g., `Merge pull request #42`) are usually noise. Look at the PR title
or the commits inside the merge. If the PR title follows Conventional Commits, use that.

---

## When you can't tell

Default to **PATCH** if the commit looks like maintenance. Escalate to **MINOR** if
there's any mention of new functionality. Escalate to **MAJOR** only with explicit
evidence of a breaking change — don't guess at breaking.

---

## Mapping categories to Keep a Changelog sections

| Category                            | Changelog section          |
| ----------------------------------- | -------------------------- |
| `breaking` + new behavior           | Changed                    |
| `breaking` + removal                | Removed                    |
| `feat`                              | Added                      |
| `fix`, `perf`                       | Fixed                      |
| `security`                          | Security                   |
| `refactor`, `docs`, `chore`, `test` | Omit (unless user-visible) |

**User-visible refactor example:** Extracting a previously internal helper into a
new public export → treat as Added, not Refactor.
