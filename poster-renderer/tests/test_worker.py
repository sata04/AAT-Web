"""The render worker: deadlines that are real, and failures that are survivable.

The point of running Matplotlib in a subprocess is that a deadline can be *enforced* rather than
merely awaited, and that a hard crash costs one request instead of the service. Both are tested
here against the genuine `spawn`ed worker, not a stub.
"""

from __future__ import annotations

import numpy as np
import pytest

from poster_renderer.errors import RenderFailedError, RenderTimeoutError
from poster_renderer.validation import PosterPlotSpec, SeriesArrays, validate_spec
from poster_renderer.worker import RenderExecutor, RenderWorker

from conftest import build_spec


@pytest.fixture
def worker():
    instance = RenderWorker(render_timeout_seconds=60.0)
    try:
        yield instance
    finally:
        instance.close()


def test_worker_renders_the_same_bytes_as_an_in_process_render(worker: RenderWorker, spec_dict):
    from poster_renderer.render import render_png

    spec = validate_spec(spec_dict)
    assert worker.render(spec) == render_png(spec)


def test_worker_is_reused_across_renders(worker: RenderWorker, spec_dict):
    """A persistent worker: Matplotlib is imported once, not once per request."""
    spec = validate_spec(spec_dict)
    worker.render(spec)
    pid = worker._process.pid  # noqa: SLF001 - identity is exactly what this test is about
    worker.render(spec)
    assert worker._process.pid == pid  # noqa: SLF001


def test_exceeding_the_deadline_kills_the_worker(spec_dict):
    """A deadline that cannot be enforced is a lie; here it costs the worker its life."""
    instance = RenderWorker(render_timeout_seconds=0.001)
    try:
        instance.start()
        with pytest.raises(RenderTimeoutError) as caught:
            instance.render(validate_spec(spec_dict))
        assert caught.value.code == "POSTER_RENDER_TIMEOUT"
        assert caught.value.http_status == 504
        # The process is gone, so the abandoned render's CPU and memory really are released.
        assert not instance.is_alive()
    finally:
        instance.close()


def test_worker_recovers_from_a_timeout(spec_dict):
    """After a killed worker, the next request gets a fresh one rather than a broken service."""
    instance = RenderWorker(render_timeout_seconds=0.001)
    try:
        with pytest.raises(RenderTimeoutError):
            instance.render(validate_spec(spec_dict))
        assert not instance.is_alive()
    finally:
        instance.close()

    recovered = RenderWorker(render_timeout_seconds=60.0)
    try:
        assert recovered.render(validate_spec(spec_dict)).startswith(b"\x89PNG\r\n\x1a\n")
    finally:
        recovered.close()


def test_worker_recovers_from_a_crash(worker: RenderWorker, spec_dict):
    spec = validate_spec(spec_dict)
    worker.render(spec)
    original_pid = worker._process.pid  # noqa: SLF001
    worker._process.kill()  # noqa: SLF001 - simulating a segfault in Agg or FreeType
    worker._process.join(timeout=10)  # noqa: SLF001

    assert worker.render(spec).startswith(b"\x89PNG\r\n\x1a\n")
    assert worker._process.pid != original_pid  # noqa: SLF001


def test_a_failing_render_is_reported_not_fatal(worker: RenderWorker, spec_dict):
    """A spec that validation could not have produced still fails cleanly, keeping the worker."""
    good = validate_spec(spec_dict)
    broken = PosterPlotSpec(
        analysis_revision_id=good.analysis_revision_id,
        run_code=good.run_code,
        poster_kind=good.poster_kind,
        poster_preset_version=good.poster_preset_version,
        x_min=good.x_min,
        x_max=good.x_max,
        y_min=good.y_min,
        y_max=good.y_max,
        series="inner",
        title=good.title,
        show_legend=good.show_legend,
        figure_width=good.figure_width,
        figure_height=good.figure_height,
        dpi=good.dpi,
        # Mismatched lengths: `validate_spec` rejects this, so only a bug could get here.
        inner=SeriesArrays(time=np.zeros(10), values=np.zeros(9)),
        drag=None,
    )

    with pytest.raises(RenderFailedError):
        worker.render(broken)

    # The worker survived, so one bad request does not cost the next one its service.
    assert worker.is_alive()
    assert worker.render(good).startswith(b"\x89PNG\r\n\x1a\n")


def test_executor_prewarm_reports_ready():
    executor = RenderExecutor()
    try:
        assert executor.is_ready() is False
        executor.prewarm()
        assert executor.is_ready() is True
    finally:
        executor.close()


def test_executor_rejects_a_negative_waiting_room():
    with pytest.raises(ValueError):
        RenderExecutor(max_queued=-1)
