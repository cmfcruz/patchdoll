---
name: conventional-commits
description: Use when an agent writes, reviews, or proposes git commit messages, PR titles, squash-merge titles, release-sensitive changelog entries, or Release Please-ready history. Apply for Slack-originated commit requests, GitHub PR drafting, and any workflow where Conventional Commits determine versioning or release notes.
---

# Conventional Commits

Use Conventional Commits so agent-authored history stays reviewable and compatible with Release Please.

## Format

Use this header shape:

```text
type(scope): subject
```

- `type` is required and lowercase.
- `scope` is optional; use a package, module, workflow, or area name such as `slack`, `github`, `docker`, `codex`, `claude`, `skills`, or `settings`.
- `subject` is required, imperative, concise, lowercase unless a proper noun is needed, and has no trailing period.
- Add a body after a blank line when the why/context matters.
- Add footers after another blank line for issue links, breaking changes, or metadata.

## Choose the type

Prefer the most specific truthful type:

| Type | Use for | Release Please impact |
| --- | --- | --- |
| `feat` | User-visible capability or behavior | Minor release |
| `fix` | User-visible bug fix | Patch release |
| `perf` | User-visible performance improvement | Patch/changelog entry in many configs |
| `docs` | Documentation-only change | Usually no version bump |
| `test` | Tests only | Usually no version bump |
| `refactor` | Internal restructure with no behavior change | Usually no version bump |
| `build` | Build system, dependencies, images | Usually no version bump unless configured |
| `ci` | CI/CD workflow changes | Usually no version bump |
| `chore` | Maintenance with no product behavior | Usually no version bump |
| `style` | Formatting-only changes | Usually no version bump |

Do not hide user-visible changes behind `chore`; Release Please can only work with the signal it receives.

## Breaking changes

Mark breaking changes with `!` in the header, a `BREAKING CHANGE:` footer, or both.

```text
feat(api)!: require signed webhook payloads

BREAKING CHANGE: Unsigned webhook requests are now rejected before routing.
```

Use breaking-change markers only when callers, users, operators, config, APIs, data formats, or deployment assumptions must change.

## Examples

Valid Patchdoll-style headers:

```text
feat(settings): add Claude provider selection
fix(slack): ignore hidden action blocks in quoted thread text
docs(skills): document Conventional Commit usage
test(github): cover webhook signature validation
build(docker): install container runtime tools
ci(release): add PR title validation
chore(deps): update npm lockfile
```

Valid multi-line commit:

```text
fix(codex): preserve real newlines in proposed commit messages

Write Slack-originated commit messages through a temp file so agents do not
accidentally pass literal \n sequences to git.

Refs: #12
```

Invalid examples:

```text
update stuff
Fixed bug.
chore: add user-visible Slack action handling
feat: Added release please workflow.
fix(github): patch webhook bug.
```

Why they are invalid: vague subject, wrong casing/tense, wrong type, past-tense subject, or trailing punctuation.

## PR titles and GitHub hygiene

When squash merge uses the PR title as the commit subject, draft the PR title as a Conventional Commit header.

- Use `feat(...)` or `fix(...)` for user-visible changes.
- Use `docs(...)`, `test(...)`, `ci(...)`, `build(...)`, or `chore(...)` for non-release-impacting work.
- Keep PR bodies human-readable; only the title needs to be a valid commit header unless the repository requires more.
- Inspect commits before asking for merge if the branch contains multiple commits.
- Use authenticated `gh` CLI for GitHub actions and metadata.
- For `cmfcruz` or `patchdoll` repositories, add `cmfcruz` as reviewer unless the user says otherwise.

## Git commit workflow reminders

When preparing a commit:

1. Preserve unrelated user changes.
2. Stage only files scoped to the requested task.
3. Write messages with real newlines, never literal `\n` escape sequences.
4. For Slack-originated commit requests, stage the requested changes, write the proposed message to `/tmp/patchdoll-commit-message.txt`, show it to the user, and wait for confirmation before running `git commit`.
5. Report changed paths and checks run separately from the commit message.

## Release Please note

Release Please reads Conventional Commits to decide changelog entries and version bumps. In normal Patchdoll work, do not create special Release Please wording. Instead, choose the correct Conventional Commit type, scope, and breaking-change marker. Only ask for trusted user guidance when release automation requires unusual handling.
