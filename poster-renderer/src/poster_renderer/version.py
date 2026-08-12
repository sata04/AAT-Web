"""Version identifiers used by the renderer.

Two distinct versions matter here and they are deliberately not the same string.
"""

from __future__ import annotations

# The AAT version stamped into the figure watermark ("AAT v11.1.0").
#
# This is part of the FROZEN VISUAL CONTRACT: it is drawn into the image, so changing it changes
# every pixel of the watermark and therefore the PNG. It tracks the AAT release whose exported
# figures this renderer reproduces — currently the desktop application's `version` in
# /home/user/AAT/pyproject.toml (11.1.0), read at runtime there by core/version.py and drawn by
# gui/plot_controller.py::_add_version_watermark.
#
# Bumping it is a visual-contract change: see README.md, "Changing the contract".
APP_VERSION = "11.1.0"

# Build identity of this container image. Reported by GET /health and in the
# X-Poster-Renderer-Version response header so a stored PosterFigureRecord can record exactly
# which renderer produced its PNG. It is NOT drawn into the figure, so bumping it does not change
# any pixel — only the PNG's `Software` metadata text chunk, which is intentionally decoupled
# from the pixel contract.
RENDERER_VERSION = "aat-poster-renderer/1.0.0"

__all__ = ["APP_VERSION", "RENDERER_VERSION"]
