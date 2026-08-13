#!/bin/bash
#
# SessionStart hook for AAT Web on Claude Code for the web.
#
# Everything here is something a session in this repository otherwise discovers the hard way, in
# roughly the order it bites. Each step is idempotent and safe to re-run; the container image is
# cached after this completes, so a warm session pays almost none of it again.
#
# The hook is deliberately synchronous. The first thing an agent does here is usually `pnpm test`,
# and an async hook would let that start against a missing node_modules — a confusing failure that
# looks like a broken repository rather than a race.

set -euo pipefail

# Local checkouts are the developer's own environment; do not reconfigure them.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

say() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------------------------------------
# 1. Commit identity — first, because it is the one mistake this repository cannot absorb
# ---------------------------------------------------------------------------------------------
#
# See AGENTS.md. The original history — 37 commits — was written under the application's name and
# an unrelated address because an agent passed `-c user.name=...` on every commit. Correcting it
# meant rewriting every SHA. A fresh clone has no identity configured and no committed hook enabled,
# so both are set here rather than left for the first `git commit` to guess at.
say 'commit identity'
git config core.hooksPath .githooks
git config user.name  "sata04"
git config user.email "88605918+sata04@users.noreply.github.com"
# Refuse to invent `root@somebox.localdomain` if the above ever goes missing: fail loudly instead.
git config user.useConfigOnly true
echo "author:    $(git var GIT_AUTHOR_IDENT)"
echo "committer: $(git var GIT_COMMITTER_IDENT)"

# ---------------------------------------------------------------------------------------------
# 2. Node dependencies
# ---------------------------------------------------------------------------------------------
#
# --frozen-lockfile on purpose: pnpm-workspace.yaml carries the supply-chain gates (minimumReleaseAge,
# blockExoticSubdeps, trustPolicy, allowBuilds) and a resolution step that is allowed to move
# versions is a resolution step that can walk around them.
say 'pnpm install'
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------
# 3. Playwright's browser
# ---------------------------------------------------------------------------------------------
#
# The image ships a Chromium whose build number will not match the one @playwright/test expects, and
# `playwright install` is unavailable. playwright.config.ts reads AAT_E2E_CHROMIUM_PATH for exactly
# this case, so the browser that exists is pointed at instead of a download being attempted.
say 'playwright browser'
CHROMIUM="$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$CHROMIUM" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export AAT_E2E_CHROMIUM_PATH=$CHROMIUM" >> "$CLAUDE_ENV_FILE"
  echo "AAT_E2E_CHROMIUM_PATH=$CHROMIUM"
else
  echo "no pre-provisioned Chromium found; Playwright will use its own resolution"
fi

# ---------------------------------------------------------------------------------------------
# 4. Docker, for everything Python
# ---------------------------------------------------------------------------------------------
#
# Not a convenience. The image's `python3` is 3.11, and both pinned requirement files declare
# numpy >= 3.12 with no cp311 wheels, so the golden fixtures and the renderer suite CANNOT run on
# the host interpreter at all. They run inside containers instead:
#
#   docker build -t aat-poster-renderer:ci poster-renderer
#   docker run --rm --network none aat-poster-renderer:ci python -m pytest /app/tests -q
#
# Two things about this sandbox that will otherwise cost an hour:
#   - Outbound TLS is intercepted, so a `pip install` inside a build fails certificate verification.
#     Build with `--network host` and put /root/.ccr/ca-bundle.crt into the build context, injecting
#     it in a scratch Dockerfile. NEVER edit poster-renderer/Dockerfile to do this — that file is
#     part of the visual contract and the runtime stage must stay byte-for-byte what CI builds.
#   - POSTER_STRICT_REFERENCE_BYTES=1 makes the renderer suite assert byte equality with the
#     committed reference PNG. It is meaningful only inside the image, which is the environment that
#     produced the reference, and it is the strongest check this repository has.
#
# Best-effort: a session that never touches the renderer should not fail to start over this.
say 'docker daemon'
if command -v dockerd >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    echo "already running"
  else
    (dockerd >/tmp/dockerd.log 2>&1 &)
    for _ in $(seq 1 20); do
      if docker info >/dev/null 2>&1; then break; fi
      sleep 1
    done
    docker info >/dev/null 2>&1 && echo "started" || echo "could not start; see /tmp/dockerd.log"
  fi
else
  echo "dockerd not present; Python suites will be unavailable"
fi

# ---------------------------------------------------------------------------------------------
# 5. What the agent should know before it starts
# ---------------------------------------------------------------------------------------------
say 'ready'
cat <<'NOTES'
Commands:
  pnpm lint | pnpm typecheck | pnpm build
  pnpm test                        Node + DOM + workerd suites across all packages
  pnpm check:bundle                wrangler dry-run and the Worker size gate
  pnpm --filter @aat/web exec playwright test        E2E (needs AAT_E2E_CHROMIUM_PATH)
  node scripts/check-commit-identity.mjs --all       identity audit

Python runs in containers, never on the host interpreter (see the comment in this hook).

Do not casually change: packages/analysis-core/src/numeric.ts, tests/golden/**,
poster-renderer/src/poster_renderer/preset.py, packages/plot-spec/src/presets.ts,
reference/python/core/**. See CLAUDE.md and AGENTS.md.
NOTES
