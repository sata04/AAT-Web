# Supply-chain policy

AAT Web is a small research tool maintained by a small team. It cannot afford a
security team, so its defence against dependency compromise is arranged to work
without one: the gates are automatic, they fail closed, and the routine path
(taking updates) stays cheap enough that nobody is tempted to disable them.

The threat this addresses is a package takeover — a maintainer account is
compromised and a malicious version is published to npm or PyPI. Historically
those are caught and unpublished within hours to a few days.

## Layer 1 — pnpm refuses to install

`pnpm-workspace.yaml`:

| setting | effect |
| --- | --- |
| `minimumReleaseAge: 10080` | Refuse any version published less than 7 days ago. Skipping that window removes most of the exposure at no ongoing cost. |
| `blockExoticSubdeps: true` | Refuse transitive dependencies fetched from anywhere but the npm registry (`git+https`, arbitrary tarballs). Every AAT dependency is an ordinary npm package, so anything caught here is itself the signal. |
| `trustPolicy: no-downgrade` | Refuse a version whose publish provenance is weaker than an earlier release's — a common takeover signature. Orthogonal to release age: it catches takeovers that seven days of waiting would not surface. |
| `allowBuilds` | Install/build scripts run **only** for explicitly listed packages. Everything else is blocked, so a compromised transitive dependency cannot execute code at install time. |

### The build-script allowlist

Currently three entries, and it should stay near that size:

```yaml
allowBuilds:
  "@biomejs/biome": true   # downloads the platform-native linter binary
  esbuild: true            # downloads the platform-native bundler binary
  workerd: true            # downloads the Cloudflare Workers runtime binary
```

Each is a native-binary fetch that genuinely cannot work without a postinstall
step. When a new dependency asks for build permission, the answer is "no" until
someone has read what its script does. Adding an entry means accepting that the
package can run arbitrary code on every developer's machine and in CI.

### Audited trust-policy exceptions

`trustPolicyExclude` currently holds two entries, both reached through
`workbox-build` (a `vite-plugin-pwa` dependency):

- **`@trickfilm400/rollup-plugin-off-main-thread@3.0.0-pre1`** — the same
  publisher shipped `2.5.0` with provenance and then this prerelease without it
  32 minutes later (2025-12-02); the later `4.0.0-pre2` is published by a
  trusted publisher again. Audited as a packaging slip, not a takeover.
- **`semver@6.3.1`** — a backport of the ReDoS fix CVE-2022-25883 onto the v6
  line (2023-07-10). Contemporary v7 releases carried provenance, so
  publish-date ordering flags it as a downgrade, but it is a legitimate
  npm/node release.

Every entry needs this kind of note. An unexplained exclusion is indistinguishable
from someone silencing a real alarm.

## Layer 2 — Renovate proposes carefully

`renovate.json5`, on top of `config:best-practices`:

- 7-day minimum release age, aligned across the top level and the npm
  datasource (the preset's `security:minimumReleaseAgeNpm` would otherwise
  override it to 3 days and produce PRs pnpm refuses to install).
- `internalChecksFilter: "strict"` — if the newest release is inside the
  window, propose the newest one outside it rather than nothing.
- minor/patch auto-merge on green CI; `0.x` auto-merges patches only, since a
  `0.x` minor can be breaking.
- Majors always get a human.
- Weekly `lockFileMaintenance` with auto-merge, so transitive dependencies do
  not rot. Everything landing there has already passed all three pnpm gates.
- **Deployment-path dependencies wait 30 days**: `wrangler`,
  `@cloudflare/vite-plugin`, `@cloudflare/vitest-pool-workers`, `pnpm`, the
  pinned `actions/*` and `DopplerHQ/*`. These run where production credentials
  exist or build what gets deployed. They keep auto-merge — "wait longer" is a
  better mitigation than "a human skims the diff", which decays into rubber
  stamping. Take one sooner by opening the PR from the Dependency Dashboard.
- **Poster-renderer dependencies never auto-merge, at any update type.** See
  below.

## The poster renderer is a visual contract

Matplotlib, NumPy, FreeType, the font stack and the Python base image all change
rendered pixels. A patch bump can move a tick label by a pixel and quietly
invalidate the compatibility guarantee that is the entire reason the container
exists — the desktop application and AAT Web are supposed to produce the same
research figure.

So `poster-renderer/**` updates are labelled `visual-contract` /
`needs-visual-review` and never auto-merge. The review procedure is in
`docs/poster-renderer.md`: run the visual regression suite, look at the
rendered diff, and only then merge.

## GitHub Actions

- `permissions: {}` at the top level of every workflow, with the minimum
  re-granted per job. A later change to the repository's default workflow
  permissions cannot widen anything.
- Every action pinned to a full commit SHA, with the version in a trailing
  comment. Tag re-pointing becomes a no-op; Renovate keeps the digests fresh.
- `persist-credentials: false` on every checkout. No job pushes, so leaving
  `GITHUB_TOKEN` in `.git/config` would only give code that escapes the sandbox
  something to steal.
- `pnpm install --frozen-lockfile` everywhere — CI never resolves a version the
  lockfile does not already pin, so the layer-1 gates cannot be bypassed by a
  stale lockfile.
- Explicit `timeout-minutes` on every job.
- pnpm is installed from the `packageManager` field rather than a third-party
  action, keeping one source of truth and one fewer action in the trust set.
- Python dependencies install with `--require-hashes`.

## Emergency security updates

A minimum release age must not become a reason that a known-exploited
vulnerability sits unfixed. The procedure is deliberately narrow — one version,
temporarily:

1. **Confirm the advisory.** Read it. Establish that AAT Web actually reaches
   the vulnerable code path; a transitive dependency in a dev-only tool is a
   different urgency from something in the Worker.
2. **Identify the exact fixed version.** Not a range.
3. **Add a single-version exception** to `pnpm-workspace.yaml`:
   ```yaml
   minimumReleaseAgeExclude:
     # Security update: <advisory id>, <one line on what it fixes>
     - package-name@1.2.3
   ```
   Never raise or remove the global `minimumReleaseAge`. Never use a range.
4. **Update** and run the full suite: lint, typecheck, unit tests, Worker tests,
   golden numerical tests, Excel regression, poster visual regression, build,
   and `wrangler deploy --dry-run`.
5. **Merge** with the advisory referenced in the commit message.
6. **Remove the exception** once the version has aged past the normal window —
   the next `lockFileMaintenance` run is a natural point. Leaving entries behind
   turns the exclusion list into a permanent hole.

## Reviewing a new dependency

Every runtime dependency needs a reason. Before adding one, work through:

- Can the platform already do this? `fetch`, `Blob`, `CompressionStream`,
  `TextDecoder`, `crypto.subtle` and `Intl` between them remove the need for
  most small utility packages.
- What is its install-script footprint, its transitive count, and its licence?
- Is it maintained, and does it publish with provenance?
- What breaks if it is abandoned in a year?

`docs/dependency-audit.md` records the answers for every current dependency:
purpose, exact version, licence, direct or transitive, whether it requests
install scripts, which runtime it targets, and what alternatives were rejected
and why. A dependency that is not in that table should not be in the lockfile.
