"""The renderer's error taxonomy.

Only the Cloudflare Worker ever talks to this container, so these codes are an *internal*
contract, not a user-facing one. They are English and machine-first; the Worker maps them onto
the localised, user-facing taxonomy in `packages/shared/src/errors.ts` (which is Japanese-first,
matching the desktop application's `core/exceptions.py`). The mapping is documented in README.md.

Two codes are deliberately spelled the same as the shared taxonomy's, because they mean exactly
the same thing on both sides of the boundary and are forwarded rather than translated:

  * ``POSTER_BUSY``           -> shared POSTER_BUSY (HTTP 429)
  * ``POSTER_RENDER_FAILED``  -> shared POSTER_RENDER_FAILED (HTTP 500)

Error bodies never echo client input back. A rejected title or run code is described by field
path and rule, never quoted, so no client-controlled bytes can be reflected into a response, a
log line, or anything downstream that renders one.
"""

from __future__ import annotations

import json
from typing import Any


class RenderServiceError(Exception):
    """Base class for every error this service converts into an HTTP response."""

    code = "POSTER_RENDER_FAILED"
    http_status = 500

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


class SpecValidationError(RenderServiceError):
    """The request body is not a valid poster plot spec.

    The Worker validates with Zod first, so reaching this means the Worker sent something the
    shared schema would have rejected: from the Worker's point of view it is an internal error,
    not something to show a user.
    """

    code = "POSTER_SPEC_INVALID"
    http_status = 400


class PayloadTooLargeError(RenderServiceError):
    """The request body exceeds the transport cap (checked before the body is read)."""

    code = "POSTER_PAYLOAD_TOO_LARGE"
    http_status = 413


class BusyError(RenderServiceError):
    """A render is already in flight and the waiting room is full. Safe to retry."""

    code = "POSTER_BUSY"
    http_status = 429


class RenderTimeoutError(RenderServiceError):
    """A render exceeded its deadline and its worker process was killed."""

    code = "POSTER_RENDER_TIMEOUT"
    http_status = 504


class RenderFailedError(RenderServiceError):
    """Rendering raised. The spec validated, so this is a renderer fault, not a client fault."""

    code = "POSTER_RENDER_FAILED"
    http_status = 500


class MethodNotAllowedError(RenderServiceError):
    code = "POSTER_METHOD_NOT_ALLOWED"
    http_status = 405


class NotFoundError(RenderServiceError):
    code = "POSTER_NOT_FOUND"
    http_status = 404


class UnsupportedMediaTypeError(RenderServiceError):
    code = "POSTER_UNSUPPORTED_MEDIA_TYPE"
    http_status = 415


class LengthRequiredError(RenderServiceError):
    """No usable ``Content-Length``. Chunked bodies are refused rather than streamed."""

    code = "POSTER_LENGTH_REQUIRED"
    http_status = 411
