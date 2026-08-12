"""The HTTP surface: `POST /render` and `GET /health`.

Built on `http.server` from the standard library. That is a deliberate choice, not laziness: this
service has two endpoints, one content type, and exactly one client (the Cloudflare Worker). A web
framework would add a dependency tree to a container whose entire value proposition is that its
dependency set is pinned, auditable and never changes without a visual-regression review. The
things a framework would buy — routing, body parsing, validation — are respectively three lines,
one line, and the thing this service most needs to do by hand anyway.

The security posture, in one place:

  * Nothing from a request reaches a filesystem path, a shell, or Matplotlib's configuration.
    PNG bytes are produced in an in-memory buffer.
  * The body size cap is enforced from `Content-Length` before any of the body is read, and again
    while reading, so an over-long or lying body is never fully buffered.
  * Chunked bodies are refused: without `Content-Length` there is no cap to check up front.
  * Responses never echo request content. Errors carry a machine code and a fixed message.
  * Logs record method, path, status, code and byte counts — never a title, a run code, or a body.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from . import preset
from .config import ServiceConfig
from .errors import (
    BusyError,
    LengthRequiredError,
    MethodNotAllowedError,
    NotFoundError,
    PayloadTooLargeError,
    RenderFailedError,
    RenderServiceError,
    SpecValidationError,
    UnsupportedMediaTypeError,
)
from .validation import parse_request_json, validate_spec
from .version import APP_VERSION, RENDERER_VERSION
from .worker import RenderExecutor

logger = logging.getLogger("poster_renderer.service")

RENDER_PATH = "/render"
HEALTH_PATH = "/health"
JSON_CONTENT_TYPE = "application/json"
PNG_CONTENT_TYPE = "image/png"

#: Fixed, so no client-controlled text can ever appear in a response header.
PNG_CONTENT_DISPOSITION = 'attachment; filename="poster.png"'

#: Chunks used to drain the request body, so a declared length is never trusted as an allocation.
_READ_CHUNK_BYTES = 1 << 16


class PosterRequestHandler(BaseHTTPRequestHandler):
    """Handles one connection. Stateless apart from the executor it borrows from the server."""

    # HTTP/1.1 so the Worker can keep the connection alive across a burst; every response
    # therefore carries an explicit Content-Length.
    protocol_version = "HTTP/1.1"
    server_version = "aat-poster-renderer"
    # Suppress the default "Python/3.12.3" Server header suffix: version disclosure with no upside.
    sys_version = ""

    # -- plumbing ------------------------------------------------------------------------------

    @property
    def _executor(self) -> RenderExecutor:
        return self.server.executor  # type: ignore[attr-defined]

    @property
    def _config(self) -> ServiceConfig:
        return self.server.config  # type: ignore[attr-defined]

    def version_string(self) -> str:
        """The `Server` header. The default appends "Python/3.12.3"; disclosure with no upside."""
        return self.server_version

    def log_message(self, format: str, *args: Any) -> None:
        """Silence `http.server`'s stderr logging; this service logs its own structured lines."""

    def log_error(self, format: str, *args: Any) -> None:
        """Also silenced — the default implementation logs the raw request line."""

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        extra_headers: dict[str, str] | None = None,
        close: bool = False,
    ) -> None:
        if close:
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Poster-Renderer-Version", RENDERER_VERSION)
        if close:
            self.send_header("Connection", "close")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_error_response(self, error: RenderServiceError, *, close: bool = False) -> None:
        extra: dict[str, str] = {}
        if isinstance(error, MethodNotAllowedError):
            extra["Allow"] = "GET, POST"
        if isinstance(error, BusyError):
            # Render slots free up on the order of a render; a second or two is an honest hint.
            extra["Retry-After"] = "2"
        self._send(
            error.http_status,
            error.to_json_bytes(),
            f"{JSON_CONTENT_TYPE}; charset=utf-8",
            extra_headers=extra,
            close=close,
        )
        logger.info(
            "%s %s -> %d %s", self.command, self._path(), error.http_status, error.code
        )

    def _path(self) -> str:
        """The request path with any query string dropped, for routing and logging."""
        try:
            return urlsplit(self.path).path
        except ValueError:
            return ""

    # -- request-body handling -----------------------------------------------------------------

    def _content_length(self) -> int:
        """Validate `Content-Length` *before* reading anything. Raises on anything unusable."""
        if self.headers.get("Transfer-Encoding"):
            # A chunked body has no declared size, so the payload cap could only be enforced by
            # reading until it is exceeded. Refusing outright is simpler and cheaper.
            raise LengthRequiredError("a chunked request body is not accepted; send Content-Length")

        raw = self.headers.get("Content-Length")
        if raw is None:
            raise LengthRequiredError("Content-Length is required")
        try:
            length = int(raw)
        except ValueError:
            raise SpecValidationError("Content-Length is not an integer") from None
        if length < 0:
            raise SpecValidationError("Content-Length is negative")
        if length > self._config.max_request_bytes:
            raise PayloadTooLargeError(
                f"request body exceeds the {self._config.max_request_bytes}-byte limit"
            )
        return length

    def handle_expect_100(self) -> bool:
        """Answer `Expect: 100-continue` only for a body we are actually willing to receive."""
        try:
            self._content_length()
        except RenderServiceError as error:
            self._send_error_response(error, close=True)
            return False
        return super().handle_expect_100()

    def _read_body(self, length: int) -> bytes:
        chunks: list[bytes] = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, _READ_CHUNK_BYTES))
            if not chunk:
                break
            remaining -= len(chunk)
            chunks.append(chunk)
        body = b"".join(chunks)
        if len(body) != length:
            raise SpecValidationError("request body is shorter than its Content-Length")
        return body

    def _check_content_type(self) -> None:
        raw = self.headers.get("Content-Type")
        if raw is None:
            raise UnsupportedMediaTypeError(f"Content-Type must be {JSON_CONTENT_TYPE}")
        media_type = raw.split(";", 1)[0].strip().lower()
        if media_type != JSON_CONTENT_TYPE:
            raise UnsupportedMediaTypeError(f"Content-Type must be {JSON_CONTENT_TYPE}")

    # -- routing -------------------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - name mandated by BaseHTTPRequestHandler
        path = self._path()
        if path == HEALTH_PATH:
            self._handle_health()
            return
        if path == RENDER_PATH:
            self._send_error_response(MethodNotAllowedError("use POST for /render"))
            return
        self._send_error_response(NotFoundError("no such endpoint"))

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = self._path()
        if path == HEALTH_PATH:
            self._send_error_response(MethodNotAllowedError("use GET for /health"))
            return
        if path != RENDER_PATH:
            self._send_error_response(NotFoundError("no such endpoint"))
            return
        self._handle_render()

    def _unsupported_method(self) -> None:
        self._send_error_response(MethodNotAllowedError("method not allowed"))

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _unsupported_method

    # -- endpoints -----------------------------------------------------------------------------

    def _handle_health(self) -> None:
        body = json.dumps(
            {
                "status": "ok",
                "rendererVersion": RENDERER_VERSION,
                "appVersion": APP_VERSION,
                "presetVersion": preset.PRESET_VERSION,
                "workerReady": self._executor.is_ready(),
                "maxQueued": self._executor.max_queued,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self._send(HTTPStatus.OK, body, f"{JSON_CONTENT_TYPE}; charset=utf-8")

    def _handle_render(self) -> None:
        server: PosterRenderServer = self.server  # type: ignore[assignment]
        if not server.acquire_request_slot():
            # Nothing has been read from the socket, so this connection cannot be reused.
            self._send_error_response(BusyError("too many concurrent requests"), close=True)
            return
        try:
            self._render()
        finally:
            server.release_request_slot()

    def _render(self) -> None:
        try:
            length = self._content_length()
        except RenderServiceError as error:
            # The body was never read, so the connection is out of sync and must not be reused.
            self._send_error_response(error, close=True)
            return

        try:
            self._check_content_type()
        except RenderServiceError as error:
            # Drain first: the body is within the cap, so consuming it keeps keep-alive usable.
            try:
                self._read_body(length)
            except (RenderServiceError, OSError):
                self._send_error_response(error, close=True)
                return
            self._send_error_response(error)
            return

        try:
            body = self._read_body(length)
        except RenderServiceError as error:
            self._send_error_response(error, close=True)
            return
        except (TimeoutError, socket.timeout, OSError):
            self.close_connection = True
            return

        try:
            spec = validate_spec(parse_request_json(body))
        except RenderServiceError as error:
            self._send_error_response(error)
            return

        try:
            png = self._executor.render(spec)
        except RenderServiceError as error:
            self._send_error_response(error)
            return
        except Exception as error:  # noqa: BLE001 - never leak a traceback to the caller
            logger.exception("unexpected render failure")
            self._send_error_response(RenderFailedError(f"internal renderer fault: {type(error).__name__}"))
            return

        self._send(
            HTTPStatus.OK,
            png,
            PNG_CONTENT_TYPE,
            extra_headers={
                "Content-Disposition": PNG_CONTENT_DISPOSITION,
                "X-Poster-Preset-Version": preset.PRESET_VERSION,
            },
        )
        logger.info(
            "POST %s -> 200 bytes_in=%d bytes_out=%d dpi=%d",
            RENDER_PATH,
            length,
            len(png),
            spec.dpi,
        )


class PosterRenderServer(ThreadingHTTPServer):
    """Threaded HTTP server owning the single render executor."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self, config: ServiceConfig, executor: RenderExecutor) -> None:
        self.config = config
        self.executor = executor
        # Bounds how many requests are simultaneously parsing bodies. Rendering itself is already
        # serialised by the executor; this stops a burst of large uploads from multiplying the
        # per-request buffers.
        self._request_slots = threading.BoundedSemaphore(config.max_concurrent_requests)
        PosterRequestHandler.timeout = config.socket_timeout_seconds
        super().__init__((config.host, config.port), PosterRequestHandler)

    def acquire_request_slot(self) -> bool:
        return self._request_slots.acquire(blocking=False)

    def release_request_slot(self) -> None:
        self._request_slots.release()

    def server_close(self) -> None:
        try:
            super().server_close()
        finally:
            self.executor.close()


def create_server(config: ServiceConfig) -> PosterRenderServer:
    """Build a server and its executor. The caller decides when to serve."""
    executor = RenderExecutor(
        render_timeout_seconds=config.render_timeout_seconds,
        startup_timeout_seconds=config.startup_timeout_seconds,
        max_queued=config.max_queued,
    )
    return PosterRenderServer(config, executor)


__all__ = [
    "HEALTH_PATH",
    "RENDER_PATH",
    "PosterRenderServer",
    "PosterRequestHandler",
    "create_server",
]
