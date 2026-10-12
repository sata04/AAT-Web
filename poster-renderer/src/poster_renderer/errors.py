"""The renderer's error taxonomy.

The renderer runs inside the browser under Pyodide (CPython on WASM), in a dedicated Web Worker.
The engine's Python bridge serialises these codes across the JS/Python boundary, so they are an
*internal* contract, not a user-facing one. They are English and machine-first; the app's poster
error surface (`apps/web/src/poster/errors.ts`) maps them onto the localised, user-facing
`PosterSpecAdvice` taxonomy, which is Japanese-first, matching the desktop application's
`core/exceptions.py`.

`POSTER_RENDER_FAILED` is deliberately spelled the same as the shared taxonomy's code in
`packages/shared/src/errors.ts`, because it means exactly the same thing on both sides of the
boundary and is forwarded rather than translated.

Error payloads never echo client input back. A rejected title or run code is described by field
path and rule, never quoted, so no client-controlled bytes can be reflected into a response, a
log line, or anything downstream that renders one.
"""

from __future__ import annotations

import json
from typing import Any


class RendererError(Exception):
    """Base class for every error the engine bridge serialises into a response payload."""

    code = "POSTER_RENDER_FAILED"

    def __init__(self, message: str, *, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.field = field

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.field is not None:
            payload["field"] = self.field
        return payload

    def to_json_bytes(self) -> bytes:
        # `separators` and `sort_keys` keep error bodies byte-stable, which makes them assertable.
        return json.dumps(self.to_payload(), sort_keys=True, separators=(",", ":")).encode("utf-8")


class SpecValidationError(RendererError):
    """The spec is not a valid poster plot spec.

    The app validates the spec with Zod before it is ever handed to the engine, so reaching this
    means something upstream sent a spec the shared schema would have rejected — an
    engine-internal fault, not something a user caused.
    """

    code = "POSTER_SPEC_INVALID"


__all__ = ["RendererError", "SpecValidationError"]
