"""Container entry point: `python -m poster_renderer`.

Starts the HTTP service, pre-warms the render worker so the first poster does not pay for
Matplotlib's import, and shuts both down cleanly on SIGTERM (which is how a container is asked to
stop).
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
from types import FrameType

from .config import ServiceConfig, from_environment
from .service import create_server
from .version import APP_VERSION, RENDERER_VERSION


def configure_logging() -> None:
    """One structured line per event on stdout, which is where a container's logs belong."""
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def main(config: ServiceConfig | None = None) -> int:
    configure_logging()
    logger = logging.getLogger("poster_renderer")

    try:
        resolved = config if config is not None else from_environment()
    except ValueError as error:
        logger.error("invalid configuration: %s", error)
        return 2

    server = create_server(resolved)
    logger.info(
        "poster renderer listening on %s:%d renderer=%s app=%s",
        resolved.host,
        resolved.port,
        RENDERER_VERSION,
        APP_VERSION,
    )

    # Pre-warm off the serving thread: the port is already accepting connections, so a health
    # check succeeds immediately while Matplotlib loads in the worker process.
    threading.Thread(target=server.executor.prewarm, name="prewarm", daemon=True).start()

    def request_shutdown(signum: int, _frame: FrameType | None) -> None:
        logger.info("received signal %d; shutting down", signum)
        threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)

    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        logger.info("poster renderer stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
