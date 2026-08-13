# Security scanning

What scans this repository, what each scanner is for, and — more usefully — what
deliberately does not scan it.

`docs/supply-chain.md` covers the gates that stop a bad dependency being
*installed*. This covers what looks at what is already here.

## The layers

| layer | what it catches | where |
| --- | --- | --- |
| pnpm gates | a dependency that should not be installed at all | `pnpm-workspace.yaml` |
| Renovate | a dependency that has a newer or fixed version | `renovate.json5` |
| gitleaks | a credential committed to the history | `security.yml`, `.gitleaks.toml` |
| osv-scanner | a known advisory against a pinned version | `security.yml`, `osv-scanner.toml` |
| CodeQL | a vulnerability in the code we wrote | GitHub Settings, not a workflow |
| secret scanning + push protection | a credential *being* committed | GitHub Settings |

They overlap on purpose in one place only: Renovate's `osvVulnerabilityAlerts`
and the osv-scanner job both read OSV. They are not redundant. Renovate proposes
an upgrade *when one exists*; the scanner reports the exposure whether or not a
fix has been published, which is the half that matters for a dependency this
project pins deliberately.

## Secret scanning (gitleaks)

Pinned by version **and by the SHA-256 of the release artefact**, downloaded with
`curl` and verified with `sha256sum --check` — no third-party action, nothing
floating. Updating it means changing two lines together; the weekly run reports
when a newer release exists so the pin does not rot unnoticed.

| trigger | scope |
| --- | --- |
| pull request | the pull request's own commits (`base..head`, `--no-merges`) |
| push to `main`, daily, weekly, manual | the whole history |

The full re-scan is not redundant with the per-pull-request one. Gitleaks gains
rules over time, so a credential format that was invisible when a commit landed
becomes visible later, and only re-reading old commits finds it. It costs about
a second: the history is 14 MB.

### The canary

Every run first proves the scanner still works.

"No leaks found, exit 0" is the same output whether the repository is clean or
the scanner is broken — a truncated download, a rule set that failed to load, an
allowlist that grew a `.*`. `scripts/scanner-canary.mjs` writes a synthetic
credential to a temporary directory, scans it, and fails the job unless gitleaks
reports it under both an exact-pattern rule (`aws-access-token`) and an
entropy rule (`generic-api-key`) — two rules, because they can break
independently.

The fixture is generated, never committed. A committed credential-shaped string
would be a permanent finding in every full-history scan whose usual fix — an
allowlist for the path — is the exact hole the canary exists to catch, and
GitHub push protection would refuse the push that added it anyway.

The canary runs against gitleaks' **default** rules, not `.gitleaks.toml`. What
is under test is the scanner, not this repository's policy; running it through
the policy would let an over-broad allowlist silence the canary too.

### Allowlisting

`.gitleaks.toml` allowlists **values**, never paths.

`paths` is not the narrowing filter it looks like. Gitleaks applies it before
reading the file — `-l debug` prints `skipping file: global allowlist` — so any
entry naming a path skips that file entirely, every rule with it, for good. An
entry added to silence one synthetic constant in a test would also silence a real
credential pasted into the same file a year later.

Naming the exact literal has neither problem, and never allowlist a *shape*:
`inv_<32 hex>` would cover every future invitation token, including one copied
out of a running system.

## Dependency scanning (osv-scanner)

Same pinning discipline: version plus artefact checksum.

| trigger | scope |
| --- | --- |
| pull request | only when a dependency manifest changed |
| push to `main`, daily, manual | `pnpm-lock.yaml` and both `requirements.txt` |
| weekly | the above, plus the renderer container image |

Whether a pull request touched a dependency manifest is decided by the same
`scripts/detect-changes.mjs` that gates `ci.yml`, which is why that logic is
unit-tested rather than written twice in YAML.

`osv-scanner.toml` is what lets this be a **blocking** check. It enumerates the
advisories that have been looked at, each with a reason and an `ignoreUntil`
date, so a finding that is not in it fails the job. Never ignore a package —
only ids. A package-level override would also hide the next advisory for that
package, which is the finding the whole arrangement is built to surface.

The container scan is currently **reporting only**, and says so in its job
summary. The base image's Debian packages have never been triaged, and starting
a weekly red badge with no path to green is how a red badge stops meaning
anything. Making it blocking is one triage pass away: run it, record what it
reports in `osv-scanner.toml` the way the lockfile findings are recorded, remove
the `|| true`.

## Static analysis: CodeQL, and nothing else

CodeQL's **default setup** — enabled in Settings, not committed as a workflow —
covers JavaScript/TypeScript and Python, is free for public repositories, handles
fork pull requests correctly without anyone reasoning about it, and reports into
the Security tab.

Semgrep is deliberately not also configured. Two SAST engines over one small
codebase produce two copies of largely the same findings and two rule sets to
maintain, and the community rule sets are published to float — which is the
opposite of how everything else here is pinned. One good engine that somebody
reads beats three that nobody does.

## Fork pull requests

Public repositories accept pull requests from forks, which run code nobody has
reviewed. The boundary:

- **No workflow uses `pull_request_target`.** The dangerous shape —
  `pull_request_target` plus a checkout of the pull request's head — puts
  untrusted code in a job that has the repository's secrets and a writable
  token. It is not used here and must not be introduced.
- **`ci.yml` and `security.yml` hold no secrets and request no write
  permission.** Every job declares `contents: read`, the workflows declare
  `permissions: {}` at the top so the repository default cannot widen them, and
  every checkout sets `persist-credentials: false` so `GITHUB_TOKEN` is not left
  in `.git/config` where a dependency that manages to run code could read it.
- **A fork's `GITHUB_TOKEN` is read-only regardless**, so nothing above depends
  on GitHub being configured a particular way.

The result is that a fork pull request runs the *same* validation as an internal
one — full test suite, full E2E, both scanners — with nothing in scope worth
stealing. No verification is weakened for forks, and none needs a maintainer's
approval to be meaningful.

`deploy.yml` is the other side of that boundary and is manual-only
(`workflow_dispatch`), gated on `github.ref == 'refs/heads/main'`, split into a
credential-free `verify` job and a `deploy` job that runs almost nothing. Fork
code has no path into it.

## GitHub-native features worth enabling

For a public repository, in the order they pay off:

| feature | why | cost |
| --- | --- | --- |
| **Secret scanning + push protection** | Blocks a credential at `git push`, which is the only intervention that happens before the secret is published. Gitleaks is the second line, not the first. | none |
| **Private vulnerability reporting** | Gives a finder somewhere to send a report that is not a public issue. A research tool with an authenticated cloud side should not learn about a hole from a public issue. | none |
| **Dependency graph + Dependabot alerts** | Free, and reads GitHub Advisory Database, which is not identical to OSV. Alerts only — leave the *updates* to Renovate, which enforces this project's release-age and provenance policy. Two bots opening dependency pull requests is worse than one. | none |
| **CodeQL default setup** | The SAST layer, per above. | runner minutes, free for public repositories |
| **Branch protection on `main`** | The required checks below are what make any of this binding. | none |

Deliberately not recommended:

- **Dependabot version updates** — duplicates Renovate and bypasses
  `minimumReleaseAge`, `blockExoticSubdeps` and `trustPolicy`.
- **A third SAST** — see above.
- **CodeQL as a committed workflow** rather than default setup — more YAML, and
  fork pull requests then need explicit handling of the SARIF upload that
  default setup does for you.

## Required checks

Enough to be binding, few enough that each one means something:

```
Commit identity
Change detection
Lint, typecheck, test, build
Python reference and golden fixtures
Poster renderer
End-to-end (Playwright)
Secret scan
Known vulnerabilities
```

All eight are safe to require. The conditional ones report as successful when
skipped, which is what makes a documentation-only pull request mergeable without
running a container build.

Renovate auto-merges minor and patch updates on green, so these checks are also
the entire review for those pull requests. That is intentional and is why
`Known vulnerabilities` is on the list: a lockfile change that introduces a known
advisory should not be able to merge itself.
