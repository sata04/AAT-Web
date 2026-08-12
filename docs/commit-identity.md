# Commit identity

## The approved identity

Every commit in this repository must be authored **and** committed as:

```
sata04 <88605918+sata04@users.noreply.github.com>
```

The address is GitHub's noreply form, `<id>+<login>@users.noreply.github.com`,
using the account's numeric id `88605918`. It is the same identity used in
`sata04/AAT` and `sata04/examtrace`.

## What went wrong here

The repository's first 37 commits were written as:

```
AAT Web <[redacted-personal-address]>
```

for both author and committer. An agent building the project passed
`git -c user.name="AAT Web" -c user.email="…" commit` on every call: it took the
application's name as a person, and an address from its own context as that
person's email. Neither was ever an approved committer.

Two things made this invisible until someone looked:

1. **The global configuration was correct.** `~/.gitconfig` held a valid
   identity throughout. Any check that read `git config user.email` would have
   reported no problem, because the override lived on the command line.
2. **Nothing rejected it.** There was no hook and no CI check, so 37 commits
   accumulated before anyone read `git log`.

It was corrected by rewriting the whole history with `git filter-repo`, which
changed every SHA. That is cheap in a private, unreferenced, undeployed
repository and expensive in any other kind — hence the enforcement below.

## Enforcement

Three layers, because each of the first two can be skipped:

### 1. Local hook — `.githooks/pre-commit`

Runs `scripts/check-commit-identity.mjs` with no arguments, which inspects
`git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`. Those report the
**effective** identity, after `-c` overrides and `GIT_AUTHOR_*` /
`GIT_COMMITTER_*` environment variables are resolved — which is precisely what a
config-only check misses.

Committed hooks are not enabled automatically. In a fresh clone:

```bash
git config core.hooksPath .githooks
```

### 2. CI — `.github/workflows/ci.yml`

Cannot be skipped, and covers anyone who never installed the hook.

- **Pull requests** check every commit in `base..head`.
- **Pushes** check the pushed range. When the before-SHA is absent (new branch)
  or unreachable (force push), it audits every reachable commit instead of
  silently checking nothing.

`fetch-depth: 0` is required so the range exists in the runner's clone.

### 3. Full audit

```bash
node scripts/check-commit-identity.mjs --all
```

Checks every commit reachable from every ref, root commit included. `A..B`
excludes `A`, so range mode alone never inspects the root commit; this is what
proves a history rewrite was complete.

## The allowlist

`ALLOWED_IDENTITIES` in `scripts/check-commit-identity.mjs`, matched on the
**full** address so a lookalike such as `evil+sata04@users.noreply.github.com`
cannot pass:

| Address | Why it is approved |
| --- | --- |
| `88605918+sata04@users.noreply.github.com` | The repository owner. |
| `29139614+renovate[bot]@users.noreply.github.com` | Renovate raises the dependency-update PRs this repository auto-merges, so its commits must pass. |
| `noreply@github.com` | The committer GitHub records for API and web-UI commits — squash merges, and Renovate's pushes. The author is still checked, so an unapproved person committing through the web UI is still rejected. |

Names are checked too: an approved address combined with a project name such as
`AAT Web` is still rejected, because that was the original failure.

**`noreply@anthropic.com` is deliberately absent.** Agents commit as the
repository owner here. If you would rather have agent commits attributed to
Claude — as `sata04/examtrace` does — add that address to the map; it is a
one-line change and a deliberate decision, not an oversight.

## Fresh-clone setup

```bash
git config core.hooksPath .githooks
git config user.name  "sata04"
git config user.email "88605918+sata04@users.noreply.github.com"
git config user.useConfigOnly true
```

### Recommended global safety setting

```bash
git config --global user.useConfigOnly true
```

With this set, Git refuses to invent an identity from the hostname and login
when none is configured, so a missing setting fails loudly instead of silently
committing as `root@somebox.localdomain`. It is a *global developer* setting and
is recommended rather than required; this repository sets it locally regardless.

## Signing

The environment's global configuration enables SSH commit signing
(`commit.gpgsign=true`, `gpg.format=ssh`). No commit in this repository is
signed — `git log --format=%G?` reports `N` throughout — and the rewrite did not
invalidate any signature, because there were none.

No signing configuration was invented here. If signed commits are wanted,
configure `user.signingkey` with a key registered on the `sata04` GitHub account
and enable branch protection requiring signatures. Note that history rewrites
invalidate signatures, so this should be settled before the repository is
published.
