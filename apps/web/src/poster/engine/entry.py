"""JS/Python bridge for the in-browser poster engine.

Loaded into Pyodide's virtual filesystem at engine boot (see `engine-core.ts`). It owns no
rendering logic — the single source of truth is the `poster_renderer` package, which runs
unmodified here and in the pinned native test venv. This module only adapts: a JSON document in,
an ``{ok: ...}`` dict out, so the JS side never has to catch a Python exception.
"""

from __future__ import annotations

import importlib.metadata
import traceback

from poster_renderer.errors import SpecValidationError
from poster_renderer.render import render_png
from poster_renderer.validation import parse_request_json, validate_spec
from poster_renderer.version import RENDERER_VERSION


def engine_versions() -> dict:
    """Report the versions that actually drew the next figure, for provenance records."""
    return {
        "matplotlib": importlib.metadata.version("matplotlib"),
        "numpy": importlib.metadata.version("numpy"),
        "pillow": importlib.metadata.version("pillow"),
        "renderer": RENDERER_VERSION,
    }


def render_spec_json(raw) -> dict:
    """Validate then render a spec document; report failures as data, not exceptions.

    Returns ``{"ok": True, "png": bytes}`` on success and ``{"ok": False, "kind", "code",
    "message", "field"?}`` on failure, where ``kind`` is:

      * ``"spec"`` — the document failed validation. Caller-side fault: the app is expected to
        have validated already, so reaching this means a bug upstream of the engine. The payload
        still never echoes input values — field paths and rules only, the same rule every other
        error surface in the project follows.
      * ``"render"`` — a valid spec raised inside Matplotlib. Engine fault.
    """
    try:
        document = parse_request_json(raw if isinstance(raw, bytes) else raw.encode("utf-8"))
        spec = validate_spec(document)
    except SpecValidationError as error:
        return {"ok": False, "kind": "spec", **error.to_payload()}
    except Exception:
        # Anything parse/validate raises outside its typed errors is still a spec-side fault
        # (a type the caller should never have sent); it just carries no structured field.
        return {
            "ok": False,
            "kind": "spec",
            "code": "POSTER_SPEC_INVALID",
            "message": "request body is not a valid poster spec",
        }

    try:
        return {"ok": True, "png": render_png(spec)}
    except Exception:
        # The traceback text stays inside the engine: the JS side surfaces only the code and this
        # summary, so nothing client-controlled reaches a log line or the UI.
        return {
            "ok": False,
            "kind": "render",
            "code": "POSTER_RENDER_FAILED",
            "message": traceback.format_exc(limit=4).strip(),
        }
