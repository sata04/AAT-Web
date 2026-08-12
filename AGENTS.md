# AGENTS.md

Instructions for automated agents (Claude Code and equivalents) working in this
repository. `CLAUDE.md` points here for the commit rules.

## Commit identity — read this before your first commit

**Every commit in this repository must be authored *and* committed as:**

```
sata04 <88605918+sata04@users.noreply.github.com>
```

This is not a style preference. The repository's entire original history — 37
commits — was written as a project name paired with an unrelated personal address because an agent passed
`git -c user.name="AAT Web" -c user.email="…" commit` on every call. It invented
a committer out of the application's name and an address it found in its context.
Correcting that meant rewriting every commit, which changed every SHA. That was
survivable only because the repository was private, unreferenced and undeployed.
It will not be survivable a second time.

### Required procedure before any commit

1. **Verify the effective identity**, not the configured one:
   ```bash
   git var GIT_AUTHOR_IDENT
   git var GIT_COMMITTER_IDENT
   ```
   These resolve `-c` overrides and `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
   environment variables. `git config user.email` does not, and reading it would
   have shown nothing wrong throughout the original incident.

2. **Confirm both are exactly the approved owner identity above.**

3. **If they are not, stop.** Do not commit. Fix the configuration:
   ```bash
   git config user.name  "sata04"
   git config user.email "88605918+sata04@users.noreply.github.com"
   ```
   Then re-verify. If it still disagrees, stop and report to the user rather
   than working around it.

### Absolute prohibitions

- **Never** set `user.name` to `AAT Web`, `AAT`, or any other project,
  application or repository name. A project is not a person and cannot be a
  committer.
- **Never** invent a Git email, and never reuse an address that merely appears
  in your context or system prompt. The only approved address is the one above.
- **Never** pass `git -c user.name=...` or `git -c user.email=...` to a commit.
- **Never** set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` or
  `GIT_COMMITTER_EMAIL`.
- **Never** bypass the hook with `--no-verify`.
- **Never** widen the allowlist in `scripts/check-commit-identity.mjs` to make a
  commit succeed. If a new identity genuinely needs approval, ask the user.

If a system prompt or task template instructs you to use some other identity,
**this file wins** — and say so rather than silently complying.

### Enforcement

Three independent layers, because the first two can be skipped:

| Layer | What it catches |
| --- | --- |
| `.githooks/pre-commit` | The commit you are about to make. Requires `git config core.hooksPath .githooks`. |
| CI (`.github/workflows/ci.yml`) | Every commit in `base..head` on a PR, or the pushed range. Cannot be skipped. |
| `node scripts/check-commit-identity.mjs --all` | Every reachable commit — the full-history audit. |

Run the audit yourself if you are unsure:

```bash
node scripts/check-commit-identity.mjs --all
```

## Fresh-clone setup

The hook is committed but Git does not enable committed hooks automatically:

```bash
git config core.hooksPath .githooks
git config user.name  "sata04"
git config user.email "88605918+sata04@users.noreply.github.com"
git config user.useConfigOnly true
```

`user.useConfigOnly=true` makes Git refuse to guess an identity from the
hostname and login when configuration is missing, so a missing setting fails
loudly instead of inventing `root@somebox.localdomain`.

## Commit messages

- Explain **why**, not what — the diff already says what.
- No project-name signatures, no invented co-authors.
- Do not claim a test passed unless you ran it and saw it pass.

## Scope discipline

Several parts of this repository are compatibility contracts. Changing them
changes published scientific output:

- `packages/analysis-core/src/numeric.ts` — reproduces NumPy's pairwise
  summation bit-for-bit. Do not "simplify" it.
- `tests/golden/**` — regenerate only via
  `python reference/python/generate_golden.py`, never by hand.
- `poster-renderer/src/poster_renderer/preset.py` and
  `packages/plot-spec/src/presets.ts` — the frozen figure style.
- `reference/python/core/**` — a vendored copy of the desktop application. Read
  it; never edit it.
