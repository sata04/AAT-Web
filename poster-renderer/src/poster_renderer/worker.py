"""Render execution: one at a time, isolated, with a deadline that is actually enforceable.

Two problems shape this module.

**A timeout has to be real.** A Matplotlib render is a long call into C (Agg, FreeType). A
deadline implemented with a thread and a `join(timeout)` would let the caller give up while the
render kept running, so the next request would contend with a phantom job and the container's
memory would keep climbing. Running the render in a *separate process* makes the deadline
truthful: when it expires the process is killed, and the resources really do go away.

**A crash must not take the service down.** A segfault inside Agg or FreeType — the kind of thing
a font or library upgrade can introduce — would kill the whole service if the render ran in-process.
Out of process it is one failed request, and the next one gets a fresh worker.

The worker is *persistent*: it is started once, imports Matplotlib once, and then serves renders
over a pipe, so the per-request cost is the render itself. It is replaced only after a timeout or
a crash.

Admission control sits in front: exactly one render runs at a time, with a small bounded waiting
room. When both are occupied the request is rejected immediately with `POSTER_BUSY` rather than
queued — an unbounded queue would turn a burst into a slow, memory-hungry meltdown instead of a
fast, retryable "no". The API's poster endpoint is idempotent by design (see
`docs/web-architecture.md`), so a retry is always safe.
"""

from __future__ import annotations

import logging
import multiprocessing
import threading
from multiprocessing.connection import Connection
from typing import Any

from .errors import BusyError, RenderFailedError, RenderTimeoutError
from .validation import PosterPlotSpec

logger = logging.getLogger("poster_renderer.worker")

#: How long the worker process may take to import Matplotlib and report readiness.
DEFAULT_STARTUP_TIMEOUT_SECONDS = 60.0

#: Wall-clock budget for a single render, measured from the moment the spec is handed to the
#: worker. The spec's own caps (200k points, 20x20in, 600dpi) put a real render far below this;
#: exceeding it means something pathological, and the worker is killed rather than waited on.
DEFAULT_RENDER_TIMEOUT_SECONDS = 30.0

#: Extra requests allowed to wait for the render slot. 0 = no waiting room: a second simultaneous
#: render is refused immediately.
DEFAULT_MAX_QUEUED = 0

_SHUTDOWN = None


def _worker_main(connection: Connection) -> None:  # pragma: no cover - runs in a child process
    """Child process entry point: import Matplotlib once, then render specs off the pipe forever."""
    # Imported here, inside the child, so the parent process never loads Matplotlib at all.
    from .render import render_png

    try:
        connection.send(("ready",))
        while True:
            message = connection.recv()
            if message is _SHUTDOWN:
                return
            try:
                png = render_png(message)
            except BaseException as error:  # noqa: BLE001 - the parent decides what this means
                connection.send(("error", f"{type(error).__name__}: {error}"))
            else:
                connection.send(("ok", png))
    except (EOFError, OSError, KeyboardInterrupt):
        return
    finally:
        connection.close()


class RenderWorker:
    """A persistent render subprocess, replaced automatically after a timeout or a crash.

    Not thread-safe on its own: a pipe carries one request/response at a time. :class:`RenderExecutor`
    is what guarantees a single caller, and it holds the render lock across the whole exchange.
    """

    def __init__(
        self,
        *,
        render_timeout_seconds: float = DEFAULT_RENDER_TIMEOUT_SECONDS,
        startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS,
    ) -> None:
        self._render_timeout = render_timeout_seconds
        self._startup_timeout = startup_timeout_seconds
        # "spawn" rather than "fork": the parent is a threaded HTTP server, and forking a threaded
        # process inherits locks held by threads that do not exist in the child. spawn starts from
        # a clean interpreter, which is also what makes the child's Matplotlib state predictable.
        self._context = multiprocessing.get_context("spawn")
        self._process: Any = None
        self._connection: Connection | None = None

    # -- lifecycle -----------------------------------------------------------------------------

    def start(self) -> None:
        """Start the worker and wait for it to finish importing Matplotlib."""
        if self.is_alive():
            return
        self._teardown()

        parent_connection, child_connection = self._context.Pipe(duplex=True)
        process = self._context.Process(target=_worker_main, args=(child_connection,), daemon=True)
        process.start()
        # The parent must close its copy of the child end, or the pipe never reports EOF when the
        # child dies and `poll()` would block for the full timeout on every crash.
        child_connection.close()

        if not parent_connection.poll(self._startup_timeout):
            process.kill()
            process.join(timeout=5)
            parent_connection.close()
            raise RenderFailedError("render worker did not become ready in time")
        try:
            message = parent_connection.recv()
        except EOFError:
            process.join(timeout=5)
            parent_connection.close()
            raise RenderFailedError("render worker exited during startup") from None
        if message != ("ready",):
            process.kill()
            process.join(timeout=5)
            parent_connection.close()
            raise RenderFailedError("render worker sent an unexpected startup message")

        self._process = process
        self._connection = parent_connection
        logger.info("render worker started pid=%s", process.pid)

    def is_alive(self) -> bool:
        return self._process is not None and self._process.is_alive() and self._connection is not None

    def _teardown(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except OSError:
                pass
            self._connection = None
        if self._process is not None:
            if self._process.is_alive():
                self._process.kill()
            self._process.join(timeout=5)
            self._process = None

    def close(self) -> None:
        """Ask the worker to exit, then make sure it did."""
        connection = self._connection
        if connection is not None:
            try:
                connection.send(_SHUTDOWN)
            except (OSError, ValueError):
                pass
        if self._process is not None:
            self._process.join(timeout=5)
        self._teardown()

    # -- rendering -----------------------------------------------------------------------------

    def render(self, spec: PosterPlotSpec) -> bytes:
        """Render `spec` in the worker process, enforcing the deadline by killing it if need be."""
        self.start()
        connection = self._connection
        if connection is None:  # pragma: no cover - start() raises rather than returning unstarted
            raise RenderFailedError("render worker is unavailable")

        try:
            connection.send(spec)
        except (OSError, ValueError) as error:
            self._teardown()
            raise RenderFailedError(f"could not dispatch render to the worker: {type(error).__name__}") from None

        if not connection.poll(self._render_timeout):
            # The render is still running and cannot be interrupted from here, so the process goes.
            logger.warning("render exceeded %.1fs deadline; killing worker", self._render_timeout)
            self._teardown()
            raise RenderTimeoutError(f"render exceeded the {self._render_timeout:g}s deadline")

        try:
            message = connection.recv()
        except (EOFError, OSError) as error:
            self._teardown()
            raise RenderFailedError(f"render worker died mid-render: {type(error).__name__}") from None

        if isinstance(message, tuple) and message and message[0] == "ok":
            png = message[1]
            if not isinstance(png, bytes):  # pragma: no cover - defensive
                self._teardown()
                raise RenderFailedError("render worker returned a non-PNG payload")
            return png
        if isinstance(message, tuple) and message and message[0] == "error":
            # The detail is the worker's own exception text, built from our code and the spec's
            # already-validated numbers — no raw client string is interpolated into it.
            raise RenderFailedError(f"rendering failed: {message[1]}")
        self._teardown()  # pragma: no cover - defensive
        raise RenderFailedError("render worker sent an unexpected message")


class RenderExecutor:
    """Admission control around a :class:`RenderWorker`: one render at a time, bounded waiting."""

    def __init__(
        self,
        *,
        render_timeout_seconds: float = DEFAULT_RENDER_TIMEOUT_SECONDS,
        startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS,
        max_queued: int = DEFAULT_MAX_QUEUED,
        queue_wait_seconds: float | None = None,
    ) -> None:
        if max_queued < 0:
            raise ValueError("max_queued must be >= 0")
        self._worker = RenderWorker(
            render_timeout_seconds=render_timeout_seconds,
            startup_timeout_seconds=startup_timeout_seconds,
        )
        # One permit for the render slot plus one per waiting-room place. Acquired without
        # blocking, so exceeding the bound is an instant rejection, never a queue.
        self._admission = threading.BoundedSemaphore(1 + max_queued)
        self._render_lock = threading.Lock()
        self._max_queued = max_queued
        # A waiter must not sit behind an in-flight render for longer than that render is allowed
        # to take, or a stuck worker would hold requests open past the caller's own timeout.
        self._queue_wait = queue_wait_seconds if queue_wait_seconds is not None else render_timeout_seconds

    @property
    def max_queued(self) -> int:
        return self._max_queued

    def prewarm(self) -> None:
        """Start the worker before the first request, so nobody pays the import cost."""
        with self._render_lock:
            self._worker.start()

    def is_ready(self) -> bool:
        return self._worker.is_alive()

    def render(self, spec: PosterPlotSpec) -> bytes:
        if not self._admission.acquire(blocking=False):
            raise BusyError("a poster render is already in progress")
        try:
            if not self._render_lock.acquire(timeout=self._queue_wait):
                raise BusyError("timed out waiting for the render slot")
            try:
                return self._worker.render(spec)
            finally:
                self._render_lock.release()
        finally:
            self._admission.release()

    def close(self) -> None:
        self._worker.close()


__all__ = [
    "DEFAULT_MAX_QUEUED",
    "DEFAULT_RENDER_TIMEOUT_SECONDS",
    "DEFAULT_STARTUP_TIMEOUT_SECONDS",
    "RenderExecutor",
    "RenderWorker",
]
