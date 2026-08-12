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

The repository's first 37 commits were written under the **application's name**
as the author and committer, paired with an **unrelated personal email address**.
An agent building the project passed `git -c user.name="…" -c user.email="…"
commit` on every call: it treated the project name as a person, and an address
it found in its own context as that person's email. Neither was ever an approved
committer.

The offending values are deliberately not reproduced here. The address was
personal data that never belonged in this repository, and repeating it in the
documentation — or in a checker's error message — would reintroduce exactly what
the history rewrite removed. The allowlist below fails closed on any address it
does not recognise, so naming the bad one buys nothing.

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

## Signing — why every commit shows as unverified

**No commit in this repository carries a signature.** `git log --format=%G?`
reports `N` throughout, and no commit object contains a `gpgsig` header.

If GitHub displays these commits as *Unverified*, that is the expected result of
unsigned commits — and it is shown prominently if the account has **vigilant
mode** enabled (Settings → SSH and GPG keys → *Flag unsigned commits as
unverified*). It is not a broken or invalid signature; there is no signature to
be invalid.

Two independent reasons no signature could be produced:

1. **Signing is inert in the environment these commits were created in.** The
   global config sets `commit.gpgsign=true` and `gpg.format=ssh`, but a probe
   commit made with an explicit `-S` exited 0 and produced no `gpgsig` header,
   so the configured `gpg.ssh.program` does not actually sign.
2. **The only key available belongs to the build environment, not to sata04.**
   Signing commits attributed to the repository owner with an unrelated key
   would be misattribution — worse than leaving them unsigned, and GitHub would
   still report *Unverified* because the key is not on the owner's account.

No signing configuration was invented to paper over this.

### To get verified commits

1. Register a signing key (SSH or GPG) on the **sata04** GitHub account.
2. In each working copy, set `user.signingkey` to that key and
   `commit.gpgsign=true`.
3. Optionally require signatures via branch protection on `main`.

**Settle this before the repository is published.** Signatures are computed over
the commit object, so any later history rewrite invalidates every one of them —
and the whole point of a rewrite is that it is cheap only while the repository is
private and unreferenced.

The existing 40 commits cannot be retroactively signed without rewriting them
again. Whether that is worth doing is a judgement call: if verified history
matters from the first commit, do it now, in one pass, together with the
signing-key setup.
