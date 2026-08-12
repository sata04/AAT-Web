"""Configuration comes from the environment, and only from the environment."""

from __future__ import annotations

import pytest

from poster_renderer.config import (
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    DEFAULT_PORT,
    from_environment,
)
from poster_renderer.limits import MAX_REQUEST_BYTES
from poster_renderer.worker import DEFAULT_MAX_QUEUED, DEFAULT_RENDER_TIMEOUT_SECONDS


def test_defaults_are_used_when_nothing_is_set():
    config = from_environment({})
    assert config.port == DEFAULT_PORT
    assert config.max_queued == DEFAULT_MAX_QUEUED == 0
    assert config.render_timeout_seconds == DEFAULT_RENDER_TIMEOUT_SECONDS
    assert config.max_concurrent_requests == DEFAULT_MAX_CONCURRENT_REQUESTS
    # The body cap is not configurable: it is half of a contract with `packages/plot-spec`.
    assert config.max_request_bytes == MAX_REQUEST_BYTES


def test_environment_overrides_are_applied():
    config = from_environment(
        {
            "POSTER_HOST": "127.0.0.1",
            "POSTER_PORT": "9000",
            "POSTER_MAX_QUEUED": "2",
            "POSTER_RENDER_TIMEOUT_SECONDS": "12.5",
            "POSTER_MAX_CONCURRENT_REQUESTS": "4",
        }
    )
    assert config.host == "127.0.0.1"
    assert config.port == 9000
    assert config.max_queued == 2
    assert config.render_timeout_seconds == 12.5
    assert config.max_concurrent_requests == 4


@pytest.mark.parametrize(
    "environment",
    [
        {"POSTER_PORT": "0"},
        {"POSTER_PORT": "70000"},
        {"POSTER_PORT": "http"},
        {"POSTER_MAX_QUEUED": "-1"},
        {"POSTER_MAX_QUEUED": "1000"},
        {"POSTER_RENDER_TIMEOUT_SECONDS": "0"},
        {"POSTER_RENDER_TIMEOUT_SECONDS": "forever"},
        {"POSTER_MAX_CONCURRENT_REQUESTS": "0"},
    ],
)
def test_invalid_values_fail_at_startup(environment):
    """A misconfigured container must refuse to start, not start and behave surprisingly."""
    with pytest.raises(ValueError):
        from_environment(environment)


def test_empty_string_falls_back_to_the_default():
    """An unset variable and one set to "" mean the same thing in a container runtime."""
    assert from_environment({"POSTER_PORT": ""}).port == DEFAULT_PORT
