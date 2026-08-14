"""Version identifiers used by the renderer.

Two distinct versions matter here and they are deliberately not the same string. `docs/versioning.md`
is the whole picture — which of AAT Web's versions mean what, and which of them move pixels.
"""

from __future__ import annotations

# The AAT release whose gravity-level figure this renderer reproduces, stamped into the watermark
# as "AAT v11.1.0".
#
# NOT the version of any program that is running. This container is part of AAT Web, whose own
# version is 1.0.0 (`apps/web/src/app/version.ts`), and it is built and deployed on its own
# schedule under `RENDERER_VERSION` below. The number here is a **conformance claim about the
# figure**: these are AAT 11.1.0's numbers, AAT 11.1.0's framing and AAT 11.1.0's style. Both
# implementations that satisfy that definition stamp the same string, which is precisely what
# lets a figure exported from the desktop and one rendered here sit on the same poster without
# implying a change that did not happen.
#
# The claim is not taken on trust: `tests/golden/**` holds the numbers to the vendored Python
# oracle, and the preset content hash plus `tests/test_reference_image.py` hold the pixels.
#
# It was called APP_VERSION until it was renamed, because "app version" is what everyone read it
# as — including one reader who reasonably asked why AAT Web 1.0.0 was claiming to be 11.1.0.
#
# This is part of the FROZEN VISUAL CONTRACT: it is drawn into the image, so changing it changes
# every pixel of the watermark and therefore the PNG. It tracks the desktop application's
# `project.version`, read at runtime there by core/version.py and drawn by
# gui/plot_controller.py::_add_version_watermark.
#
# It is also a *provenance claim printed on a research figure*, so it is not merely restated here:
# `reference/python/REFERENCE_VERSION.txt` records the version of the AAT commit the vendored
# reference tree was taken from, and `scripts/check-versions.mjs` (run by `pnpm test`) fails if
# this constant disagrees with it. A half-finished bump cannot leave posters claiming a release
# they no longer reproduce.
#
# Bumping it is a visual-contract change: see README.md, "Changing the contract".
DESKTOP_BASELINE_VERSION = "11.1.0"

# Build identity of this container image — the version that *does* answer "which program drew
# this?". Reported by GET /health and in the X-Poster-Renderer-Version response header so a stored
# PosterFigureRecord can record exactly which renderer produced its PNG. It is NOT drawn into the
# figure, so bumping it does not change any pixel — only the PNG's `Software` metadata text chunk,
# which is intentionally decoupled from the pixel contract.
#
# Bump the MINOR when this build can produce different bytes than the previous one did from the
# same spec, and the PATCH for a change that provably cannot. This is the version that answers
# "which code drew this figure?" for a stored record, so it has to move when the answer changes
# even though — precisely because — the preset version does not.
#
#   1.1.0  a spec that omits yMin/yMax is now drawn in the preset's -1 .. 1 G frame instead of
#          being autoscaled to its own data. Specs that state their bounds are byte-identical to
#          1.0.0's output (tests/test_reference_image.py, POSTER_STRICT_REFERENCE_BYTES=1).
RENDERER_VERSION = "aat-poster-renderer/1.1.0"

__all__ = ["DESKTOP_BASELINE_VERSION", "RENDERER_VERSION"]
