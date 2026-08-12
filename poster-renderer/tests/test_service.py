"""The HTTP surface: routing, transport limits, backpressure and the render round trip.

These tests drive a real server over a real socket. The service's whole job is to be the boundary
between an untrusted body and a Matplotlib process, and a boundary is only worth testing at the
place a client actually touches it.

One server instance (module-scoped) runs the genuine subprocess-backed executor, so the
end-to-end path — socket, parser, validator, `spawn`ed worker, PNG — is exercised for real. The
backpressure tests use a second server whose worker is a controllable stub, because proving "a
second simultaneous render is refused" requires holding a render open at a known instant.
"""

from __future__ import annotations

import http.client
import json
import threading
from typing import Any

import pytest

from poster_renderer import preset
from poster_renderer.config import ServiceConfig
from poster_renderer.errors import BusyError
from poster_renderer.render import render_png
from poster_renderer.service import PosterRenderServer, create_server
from poster_renderer.validation import validate_spec
from poster_renderer.version import APP_VERSION, RENDERER_VERSION
from poster_renderer.worker import RenderExecutor

from conftest import build_spec

# A one-pixel PNG: enough for the stub worker to return something of the right content type.
STUB_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    b"\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00"
    b"\x00IEND\xaeB`\x82"
)


class ServerHandle:
    """A running server plus the plumbing to talk to it."""

    def __init__(self, server: PosterRenderServer) -> None:
        self.server = server
        self.host, self.port = server.server_address[:2]
        self._thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        self._thread.daemon = True
        self._thread.start()

    def connection(self, timeout: float = 60.0) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 60.0,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = self.connection(timeout=timeout)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post_spec(self, spec: dict[str, Any], **kwargs: Any) -> tuple[int, dict[str, str], bytes]:
        return self.request(
            "POST",
            "/render",
            body=json.dumps(spec).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            **kwargs,
        )

    def close(self) -> None:
        self.server.shutdown()
        self._thread.join(timeout=10)
        self.server.server_close()


def make_config(**overrides: Any) -> ServiceConfig:
    defaults: dict[str, Any] = {
        "host": "127.0.0.1",
        "port": 0,  # an ephemeral port, so parallel runs never collide
        "render_timeout_seconds": 60.0,
        "socket_timeout_seconds": 30.0,
    }
    defaults.update(overrides)
    return ServiceConfig(**defaults)


@pytest.fixture(scope="module")
def live_server():
    """The real thing, subprocess worker included. Pre-warmed once for the whole module."""
    server = create_server(make_config())
    server.executor.prewarm()
    handle = ServerHandle(server)
    try:
        yield handle
    finally:
        handle.close()


class StubWorker:
    """A render worker whose timing the test controls."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.render_count = 0
        self._lock = threading.Lock()

    def start(self) -> None:
        return None

    def is_alive(self) -> bool:
        return True

    def close(self) -> None:
        self.release.set()

    def render(self, spec: Any) -> bytes:
        with self._lock:
            self.render_count += 1
        self.entered.set()
        assert self.release.wait(timeout=30), "stub render was never released"
        return STUB_PNG


@pytest.fixture
def blocking_server():
    worker = StubWorker()
    config = make_config()
    executor = RenderExecutor(max_queued=0, worker=worker)  # type: ignore[arg-type]
    server = PosterRenderServer(config, executor)
    handle = ServerHandle(server)
    try:
        yield handle, worker
    finally:
        worker.release.set()
        handle.close()


# ---------------------------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------------------------


def test_health_reports_versions(live_server: ServerHandle):
    status, headers, body = live_server.request("GET", "/health")
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    payload = json.loads(body)
    assert payload["status"] == "ok"
    assert payload["rendererVersion"] == RENDERER_VERSION
    assert payload["appVersion"] == APP_VERSION
    assert payload["presetVersion"] == preset.PRESET_VERSION
    assert payload["workerReady"] is True


def test_health_does_not_leak_the_python_version(live_server: ServerHandle):
    _status, headers, _body = live_server.request("GET", "/health")
    assert headers["Server"] == "aat-poster-renderer"


# ---------------------------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------------------------


def test_render_returns_a_png(live_server: ServerHandle, spec_dict):
    status, headers, body = live_server.post_spec(spec_dict)
    assert status == 200
    assert headers["Content-Type"] == "image/png"
    assert headers["Content-Length"] == str(len(body))
    assert headers["X-Poster-Preset-Version"] == preset.PRESET_VERSION
    assert headers["X-Poster-Renderer-Version"] == RENDERER_VERSION
    # A fixed filename: no part of the response is derived from client-supplied text.
    assert headers["Content-Disposition"] == 'attachment; filename="poster.png"'
    assert body.startswith(b"\x89PNG\r\n\x1a\n")


def test_service_output_matches_an_in_process_render(live_server: ServerHandle, spec_dict):
    """The subprocess boundary must be transparent: same spec in, same bytes out."""
    _status, _headers, over_http = live_server.post_spec(spec_dict)
    assert over_http == render_png(validate_spec(spec_dict))


def test_repeated_requests_return_identical_bytes(live_server: ServerHandle, spec_dict):
    _s1, _h1, first = live_server.post_spec(spec_dict)
    _s2, _h2, second = live_server.post_spec(spec_dict)
    assert first == second


def test_hostile_title_renders_and_writes_nothing(live_server: ServerHandle, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    status, headers, body = live_server.post_spec(build_spec(title="../../etc/passwd; rm -rf /"))
    assert status == 200
    assert headers["Content-Type"] == "image/png"
    assert body.startswith(b"\x89PNG\r\n\x1a\n")
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------------------------
# Routing and transport
# ---------------------------------------------------------------------------------------------


def test_unknown_path_is_404(live_server: ServerHandle):
    status, _headers, body = live_server.request("GET", "/")
    assert status == 404
    assert json.loads(body)["code"] == "POSTER_NOT_FOUND"


def test_get_render_is_405(live_server: ServerHandle):
    status, headers, body = live_server.request("GET", "/render")
    assert status == 405
    assert headers["Allow"] == "GET, POST"
    assert json.loads(body)["code"] == "POSTER_METHOD_NOT_ALLOWED"


def test_post_health_is_405(live_server: ServerHandle):
    status, _headers, body = live_server.request("POST", "/health", body=b"{}")
    assert status == 405
    assert json.loads(body)["code"] == "POSTER_METHOD_NOT_ALLOWED"


def test_query_string_does_not_defeat_routing(live_server: ServerHandle):
    status, _headers, _body = live_server.request("GET", "/health?verbose=1")
    assert status == 200


def test_unsupported_method_is_405(live_server: ServerHandle):
    status, _headers, body = live_server.request("PUT", "/render", body=b"{}")
    assert status == 405
    assert json.loads(body)["code"] == "POSTER_METHOD_NOT_ALLOWED"


def test_wrong_content_type_is_415(live_server: ServerHandle, spec_dict):
    status, _headers, body = live_server.request(
        "POST",
        "/render",
        body=json.dumps(spec_dict).encode(),
        headers={"Content-Type": "text/plain"},
    )
    assert status == 415
    assert json.loads(body)["code"] == "POSTER_UNSUPPORTED_MEDIA_TYPE"


def test_content_type_parameters_are_tolerated(live_server: ServerHandle, spec_dict):
    status, _headers, _body = live_server.request(
        "POST",
        "/render",
        body=json.dumps(spec_dict).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    assert status == 200


def test_oversized_payload_is_rejected_before_the_body_is_read(live_server: ServerHandle):
    """Only headers are sent. A 413 proves the cap was applied to `Content-Length`, not to bytes read."""
    connection = live_server.connection(timeout=30)
    try:
        connection.putrequest("POST", "/render")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(64 * 1024 * 1024))
        connection.endheaders()  # deliberately no body
        response = connection.getresponse()
        assert response.status == 413
        assert json.loads(response.read())["code"] == "POSTER_PAYLOAD_TOO_LARGE"
    finally:
        connection.close()


def test_chunked_body_is_refused(live_server: ServerHandle, spec_dict):
    connection = live_server.connection(timeout=30)
    try:
        connection.putrequest("POST", "/render")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Transfer-Encoding", "chunked")
        connection.endheaders()
        connection.send(b"0\r\n\r\n")
        response = connection.getresponse()
        assert response.status == 411
        assert json.loads(response.read())["code"] == "POSTER_LENGTH_REQUIRED"
    finally:
        connection.close()


def test_truncated_body_is_rejected(live_server: ServerHandle):
    connection = live_server.connection(timeout=30)
    try:
        connection.putrequest("POST", "/render")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", "500")
        connection.endheaders()
        connection.send(b'{"analysisRevisionId": "x"}')
        connection.sock.shutdown(1)  # half-close: no more request bytes are coming
        response = connection.getresponse()
        assert response.status == 400
        assert json.loads(response.read())["code"] == "POSTER_SPEC_INVALID"
    finally:
        connection.close()


def test_malformed_json_is_400(live_server: ServerHandle):
    status, _headers, body = live_server.request(
        "POST", "/render", body=b"{oops", headers={"Content-Type": "application/json"}
    )
    assert status == 400
    payload = json.loads(body)
    assert payload["code"] == "POSTER_SPEC_INVALID"


def test_invalid_spec_is_400_and_names_the_field(live_server: ServerHandle):
    status, _headers, body = live_server.post_spec(build_spec(dpi=9000))
    assert status == 400
    payload = json.loads(body)
    assert payload["code"] == "POSTER_SPEC_INVALID"
    assert payload["field"] == "dpi"


def test_error_bodies_do_not_echo_client_input(live_server: ServerHandle):
    hostile = "</script><script>alert(1)</script>" + "x" * 200
    status, _headers, body = live_server.post_spec(build_spec(title=hostile))
    assert status == 400
    assert hostile.encode() not in body
    assert b"<script>" not in body


# ---------------------------------------------------------------------------------------------
# Backpressure
# ---------------------------------------------------------------------------------------------


def test_second_simultaneous_render_is_rejected_with_poster_busy(blocking_server, spec_dict):
    """A render in flight plus a full waiting room must produce 429 POSTER_BUSY, not a queue."""
    handle, worker = blocking_server

    first_result: dict[str, Any] = {}

    def first_request() -> None:
        first_result["response"] = handle.post_spec(spec_dict)

    first = threading.Thread(target=first_request)
    first.start()
    try:
        assert worker.entered.wait(timeout=30), "the first render never started"

        status, headers, body = handle.post_spec(spec_dict, timeout=30)
        assert status == 429
        payload = json.loads(body)
        assert payload["code"] == "POSTER_BUSY"
        assert headers["Retry-After"] == "2"
        # The rejected request must not have queued any work behind the in-flight one.
        assert worker.render_count == 1
    finally:
        worker.release.set()
        first.join(timeout=30)

    status, _headers, body = first_result["response"]
    assert status == 200
    assert body == STUB_PNG

    # Once the slot frees up, the very next request is served normally.
    worker.entered.clear()
    status, _headers, body = handle.post_spec(spec_dict, timeout=30)
    assert status == 200
    assert worker.render_count == 2


def test_executor_admits_exactly_one_render_at_a_time():
    worker = StubWorker()
    executor = RenderExecutor(max_queued=0, worker=worker)  # type: ignore[arg-type]
    spec = validate_spec(build_spec())

    results: list[bytes] = []
    thread = threading.Thread(target=lambda: results.append(executor.render(spec)))
    thread.start()
    try:
        assert worker.entered.wait(timeout=30)
        with pytest.raises(BusyError):
            executor.render(spec)
    finally:
        worker.release.set()
        thread.join(timeout=30)
    assert results == [STUB_PNG]


def test_executor_waiting_room_admits_one_extra_and_then_rejects():
    """`max_queued=1` allows a single waiter; the third caller is still refused immediately."""
    worker = StubWorker()
    executor = RenderExecutor(max_queued=1, worker=worker, queue_wait_seconds=30.0)  # type: ignore[arg-type]
    spec = validate_spec(build_spec())
    assert executor.max_queued == 1

    outcomes: list[str] = []
    lock = threading.Lock()

    def run() -> None:
        try:
            executor.render(spec)
        except BusyError:
            outcome = "busy"
        else:
            outcome = "ok"
        with lock:
            outcomes.append(outcome)

    in_flight = threading.Thread(target=run)
    in_flight.start()
    assert worker.entered.wait(timeout=30)

    waiter = threading.Thread(target=run)
    waiter.start()
    # The waiter has a permit but not the lock; give it a moment to reach the lock, then a third
    # caller must be refused outright rather than joining an unbounded queue.
    threading.Event().wait(0.2)
    with pytest.raises(BusyError):
        executor.render(spec)

    worker.release.set()
    in_flight.join(timeout=30)
    waiter.join(timeout=30)
    assert sorted(outcomes) == ["ok", "ok"]


def test_concurrent_health_checks_are_not_blocked_by_a_render(blocking_server, spec_dict):
    """Backpressure applies to rendering, not to readiness: a probe must still answer."""
    handle, worker = blocking_server

    thread = threading.Thread(target=lambda: handle.post_spec(spec_dict))
    thread.start()
    try:
        assert worker.entered.wait(timeout=30)
        status, _headers, body = handle.request("GET", "/health", timeout=30)
        assert status == 200
        assert json.loads(body)["status"] == "ok"
    finally:
        worker.release.set()
        thread.join(timeout=30)
