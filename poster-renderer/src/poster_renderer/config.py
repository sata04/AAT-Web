"""Service configuration.

Everything here comes from the environment, which is set by the deployment, never by a client.
There is no configuration file and no configuration endpoint: a running container's behaviour
cannot be changed by anything that arrives over the network.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

from .limits import MAX_REQUEST_BYTES
from .worker import (
    DEFAULT_MAX_QUEUED,
    DEFAULT_RENDER_TIMEOUT_SECONDS,
    DEFAULT_STARTUP_TIMEOUT_SECONDS,
)

DEFAULT_HOST = "0.0.0.0"  # noqa: S104 - a container port, published only to the Cloudflare runtime
DEFAULT_PORT = 8080

#: Read/write timeout on a client socket. Bounds how long a slow or stalled peer can hold a
#: connection (and a thread) open while dribbling out a request body.
DEFAULT_SOCKET_TIMEOUT_SECONDS = 30.0

#: Requests handled concurrently. Rendering is serialised regardless (see `worker.py`); this
#: bounds the number of requests simultaneously parsing bodies and holding buffers.
DEFAULT_MAX_CONCURRENT_REQUESTS = 8


@dataclass(frozen=True)
class ServiceConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    render_timeout_seconds: float = DEFAULT_RENDER_TIMEOUT_SECONDS
    startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS
    max_queued: int = DEFAULT_MAX_QUEUED
    socket_timeout_seconds: float = DEFAULT_SOCKET_TIMEOUT_SECONDS
    max_concurrent_requests: int = DEFAULT_MAX_CONCURRENT_REQUESTS
    max_request_bytes: int = MAX_REQUEST_BYTES


def _int(env: Mapping[str, str], name: str, fallback: int, *, minimum: int, maximum: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer") from None
    if not (minimum <= value <= maximum):
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _float(env: Mapping[str, str], name: str, fallback: float, *, minimum: float, maximum: float) -> float:
    raw = env.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number") from None
    if not (minimum <= value <= maximum):
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def from_environment(env: Mapping[str, str] | None = None) -> ServiceConfig:
    """Build a :class:`ServiceConfig`, rejecting out-of-range values at startup rather than later."""
    environ = os.environ if env is None else env
    return ServiceConfig(
        host=environ.get("POSTER_HOST") or DEFAULT_HOST,
        port=_int(environ, "POSTER_PORT", DEFAULT_PORT, minimum=1, maximum=65535),
        render_timeout_seconds=_float(
            environ, "POSTER_RENDER_TIMEOUT_SECONDS", DEFAULT_RENDER_TIMEOUT_SECONDS, minimum=1.0, maximum=600.0
        ),
        startup_timeout_seconds=_float(
            environ,
            "POSTER_STARTUP_TIMEOUT_SECONDS",
            DEFAULT_STARTUP_TIMEOUT_SECONDS,
            minimum=1.0,
            maximum=600.0,
        ),
        max_queued=_int(environ, "POSTER_MAX_QUEUED", DEFAULT_MAX_QUEUED, minimum=0, maximum=16),
        socket_timeout_seconds=_float(
            environ, "POSTER_SOCKET_TIMEOUT_SECONDS", DEFAULT_SOCKET_TIMEOUT_SECONDS, minimum=1.0, maximum=600.0
        ),
        max_concurrent_requests=_int(
            environ,
            "POSTER_MAX_CONCURRENT_REQUESTS",
            DEFAULT_MAX_CONCURRENT_REQUESTS,
            minimum=1,
            maximum=256,
        ),
    )


__all__ = ["ServiceConfig", "from_environment"]
