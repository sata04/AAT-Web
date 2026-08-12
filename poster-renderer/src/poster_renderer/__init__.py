"""AAT poster renderer — the canonical formal-poster figure renderer.

This package is the *only* thing in AAT Web that is allowed to draw a formal research figure.
It runs as a Cloudflare Container (Python + Matplotlib on the Agg backend), receives an
already-analysed, strictly validated numeric plot specification, and returns PNG bytes.

It performs no analysis, executes no client-supplied code, reads no client-supplied path, and
accepts no client-supplied Matplotlib configuration. Everything about how a poster *looks* is a
frozen constant in :mod:`poster_renderer.preset`.

Importing this package pins the Matplotlib environment before Matplotlib itself is ever imported
(see below). Every module that touches Matplotlib lives under this package, so importing any of
them necessarily runs this file first.
"""

from __future__ import annotations

import os
import tempfile

# ---------------------------------------------------------------------------------------------
# Matplotlib environment — frozen before Matplotlib is imported anywhere.
# ---------------------------------------------------------------------------------------------
#
# MPLBACKEND=Agg: the renderer is headless and must never reach for an interactive backend (Qt,
# Tk, WebAgg). WebAgg in particular would open a server socket; Agg is a pure in-memory
# rasteriser. This is forced, not defaulted, so a stray environment variable in the deployment
# platform cannot switch it.
os.environ["MPLBACKEND"] = "Agg"

# MPLCONFIGDIR: Matplotlib reads a user `matplotlibrc` from its config directory and caches the
# font list there. Pointing it at a directory we own means (a) no ambient user rc file can alter
# a single rendering parameter, and (b) the font cache lands somewhere writable, so a rendering
# does not pay for a font scan and does not emit a warning about an unwritable HOME.
if not os.environ.get("MPLCONFIGDIR"):
    os.environ["MPLCONFIGDIR"] = os.path.join(tempfile.gettempdir(), "aat-poster-mplconfig")

try:
    os.makedirs(os.environ["MPLCONFIGDIR"], mode=0o700, exist_ok=True)
except OSError:  # pragma: no cover - read-only filesystem; Matplotlib falls back on its own
    pass

from .version import APP_VERSION, RENDERER_VERSION  # noqa: E402  (must follow the env pinning)

__all__ = ["APP_VERSION", "RENDERER_VERSION"]
