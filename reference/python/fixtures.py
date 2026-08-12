#!/usr/bin/env python3
"""Golden fixture definitions — deterministic CSV inputs for the Python oracle.

Every fixture is generated from pure NumPy with a fixed seed so the bytes on
disk are reproducible on any machine. The CSV files themselves are checked in
(``tests/fixtures/csv``) so the TypeScript suite reads exactly the same bytes
the Python reference implementation saw.

Each fixture declares:
    name        directory-safe identifier
    encoding    how the CSV bytes are written (utf-8 / cp932)
    build()     returns (header: list[str], columns: list[list[str]])
    config      the AAT config overrides used when running the pipeline
    ranges      selected [xmin, xmax] windows for range-statistics goldens
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

SAMPLING_RATE = 1000
GRAVITY = 9.797578

# Column names used by the plain-ASCII fixtures.
T = "Time (s)"
INNER = "Z-axis acceleration 1(m/s2)"
DRAG = "Z-axis acceleration 2(m/s2)"

# Column names used by the Japanese fixtures — mirrors config.default.json.
T_JP = "データセット1:時間(s)"
INNER_JP = "データセット1:Z-axis acceleration 1(m/s²)"
DRAG_JP = "データセット1:Z-axis acceleration 2(m/s²)"

# CP932 has no U+00B2 SUPERSCRIPT TWO, so the Windows-31J fixture spells the
# unit out. Instruments that write CP932 files hit the same restriction.
T_CP932 = "データセット1:時間(s)"
INNER_CP932 = "データセット1:Z軸加速度 1(m/s^2)"
DRAG_CP932 = "データセット1:Z軸加速度 2(m/s^2)"


def _fmt(value: float) -> str:
    """Render a float with full round-trip precision (or blank/inf markers)."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if np.isnan(value):
        return ""
    if np.isposinf(value):
        return "inf"
    if np.isneginf(value):
        return "-inf"
    return repr(float(value))


def _cols(*arrays: Any) -> list[list[str]]:
    return [[_fmt(v) for v in arr] for arr in arrays]


def _base_config(**overrides: Any) -> dict[str, Any]:
    config: dict[str, Any] = {
        "time_column": T,
        "acceleration_column_inner_capsule": INNER,
        "acceleration_column_drag_shield": DRAG,
        "use_inner_acceleration": True,
        "use_drag_acceleration": True,
        "sampling_rate": SAMPLING_RATE,
        "gravity_constant": GRAVITY,
        "ylim_min": -1.0,
        "ylim_max": 1.0,
        "acceleration_threshold": 5.0,
        "end_gravity_level": 8.0,
        "window_size": 0.1,
        "g_quality_start": 0.1,
        "g_quality_end": 1.0,
        "g_quality_step": 0.05,
        "min_seconds_after_start": 0.7,
        "invert_inner_acceleration": True,
        "default_graph_duration": 1.45,
    }
    config.update(overrides)
    return config


@dataclass
class Fixture:
    name: str
    description: str
    build: Callable[[], tuple[list[str], list[list[str]]]]
    config: dict[str, Any]
    encoding: str = "utf-8"
    ranges: list[tuple[float, float]] = field(default_factory=lambda: [(0.1, 0.5), (0.0, 1.45)])
    newline: str = "\n"


# ---------------------------------------------------------------------------
# Signal builders
# ---------------------------------------------------------------------------


def _drop_profile(n: int, seed: int, *, release: int = 300, noise: float = 5e-3) -> np.ndarray:
    """A microgravity drop: 1g hold, release transient, quiet coast, recapture.

    Returned in raw sensor units (m/s^2), un-inverted, as the Drag Shield sees it.
    """
    rng = np.random.RandomState(seed)
    out = np.full(n, GRAVITY, dtype=np.float64)
    coast_end = min(n, release + 1200)
    # Release transient: a short, decaying shock right after release.
    shock = np.arange(release, min(release + 40, n)) - release
    out[release : release + len(shock)] = GRAVITY * np.exp(-shock / 6.0)
    quiet = np.arange(release + len(shock), coast_end)
    if quiet.size:
        t = (quiet - release) / SAMPLING_RATE
        out[quiet] = 0.02 * np.sin(2 * np.pi * 7.0 * t) + rng.normal(0, noise, quiet.size)
    if coast_end < n:
        tail = np.arange(coast_end, n) - coast_end
        # Recapture ramps past end_gravity_level (8.0 G -> 78.4 m/s^2).
        out[coast_end:] = np.minimum(GRAVITY * 12.0, 0.5 + tail * 1.2)
    return out


def _two_sensor(seed: int = 11, n: int = 3000, **kw: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    drag = _drop_profile(n, seed, **kw)
    # Inner capsule is mounted inverted (config invert_inner_acceleration).
    inner = -(_drop_profile(n, seed + 1, **kw) * 0.98)
    return time, inner, drag


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _f_normal() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor()
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_japanese() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=21)
    return [T_JP, INNER_JP, DRAG_JP], _cols(time, inner, drag)


def _f_japanese_cp932() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=21)
    return [T_CP932, INNER_CP932, DRAG_CP932], _cols(time, inner, drag)


def _f_inner_only() -> tuple[list[str], list[list[str]]]:
    time, inner, _ = _two_sensor(seed=31)
    return [T, INNER], _cols(time, inner)


def _f_drag_only() -> tuple[list[str], list[list[str]]]:
    time, _, drag = _two_sensor(seed=41)
    return [T, DRAG], _cols(time, drag)


def _f_missing_sync() -> tuple[list[str], list[list[str]]]:
    """No sample ever falls below the 5.0 m/s^2 sync threshold."""
    n = 2000
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    rng = np.random.RandomState(51)
    drag = 40.0 + rng.normal(0, 0.5, n)
    inner = -(40.0 + rng.normal(0, 0.5, n))
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_sync_nonzero() -> tuple[list[str], list[list[str]]]:
    """Sync point deliberately at a late, known index (drag and inner differ)."""
    n = 3000
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    drag = np.full(n, 20.0)
    inner = np.full(n, -20.0)
    drag[700:1900] = _drop_profile(1200, 61)[:1200] * 0.02
    inner[850:2050] = -_drop_profile(1200, 62)[:1200] * 0.02
    drag[1900:] = 90.0
    inner[2050:] = -90.0
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_nan_samples() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=71, n=2500)
    inner = inner.copy()
    drag = drag.copy()
    inner[[500, 501, 900, 1500]] = np.nan
    drag[[600, 1200, 1201, 1202]] = np.nan
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_inf_values() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=81, n=2500)
    inner = inner.copy()
    drag = drag.copy()
    inner[700] = np.inf
    inner[1300] = -np.inf
    drag[800] = np.inf
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_non_numeric() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=91, n=2200)
    inner_s = [_fmt(v) for v in inner]
    drag_s = [_fmt(v) for v in drag]
    inner_s[450] = "ERR"
    inner_s[451] = "n/a"
    drag_s[1000] = "---"
    return [T, INNER, DRAG], [[_fmt(v) for v in time], inner_s, drag_s]


def _f_non_monotonic() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=101, n=2200)
    time = time.copy()
    # Swap a pair of timestamps so the axis steps backwards twice.
    time[[1000, 1001]] = time[[1001, 1000]]
    time[1500] = time[1400]
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_duplicate_time() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=111, n=2200)
    time = time.copy()
    time[801] = time[800]
    time[802] = time[800]
    time[1600] = time[1599]
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_constant_window() -> tuple[list[str], list[list[str]]]:
    """A perfectly constant stretch — reference resolves std to exactly 0.0."""
    n = 2600
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    rng = np.random.RandomState(121)
    drag = np.full(n, 20.0)
    drag[400:2000] = rng.normal(0, 0.02, 1600)
    drag[1000:1400] = 0.125  # exactly constant window
    drag[2000:] = 90.0
    inner = -drag * 1.0
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_large_dc_offset() -> tuple[list[str], list[list[str]]]:
    """Huge mean with tiny variance — catches catastrophic cancellation."""
    n = 2600
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    rng = np.random.RandomState(131)
    drag = np.full(n, 20.0)
    drag[400:2000] = 1.0e6 + rng.normal(0, 1e-6, 1600)
    drag[2000:] = 90.0
    inner = -drag
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _spike_fixture(sign: float, seed: int) -> tuple[list[str], list[list[str]]]:
    n = 2600
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    rng = np.random.RandomState(seed)
    drag = np.full(n, 20.0)
    drag[400:2000] = rng.normal(0, 0.01, 1600)
    drag[900] = sign * 1000.0 * GRAVITY  # far beyond end_gravity_level
    drag[2000:] = 90.0
    inner = -drag
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_spike_positive() -> tuple[list[str], list[list[str]]]:
    return _spike_fixture(1.0, 141)


def _f_spike_negative() -> tuple[list[str], list[list[str]]]:
    return _spike_fixture(-1.0, 151)


def _f_tie() -> tuple[list[str], list[list[str]]]:
    """Two mathematically identical minimum-std windows — earliest must win."""
    n = 2600
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    drag = np.full(n, 20.0)
    # The baseline is noisier than the two candidate windows, so the minimum is
    # a genuine tie between two identical, non-degenerate windows rather than a
    # degenerate constant stretch. Each pattern is exactly one analysis window
    # (100 samples at 1 kHz / window_size 0.1 s) so the two full-pattern windows
    # have bit-identical standard deviations and the earliest must win.
    rng = np.random.RandomState(161)
    body = rng.normal(0, 0.02, 1600)
    pattern = np.tile([0.001, -0.001], 50)
    body[100:200] = pattern
    body[900:1000] = pattern
    # Guard samples so no window straddling a pattern boundary can undercut the
    # two pure-pattern windows; without them a lucky neighbouring noise sample
    # becomes the global minimum and the fixture stops testing tie resolution.
    for guard in (99, 200, 899, 1000):
        body[guard] = 0.2
    drag[400:2000] = body
    drag[2000:] = 90.0
    inner = -drag
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_short_data() -> tuple[list[str], list[list[str]]]:
    """Fewer samples than one analysis window — statistics must be None."""
    n = 40
    time = np.arange(n, dtype=np.float64) / SAMPLING_RATE
    drag = np.linspace(0.01, 0.02, n)
    inner = -drag
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_comparison_a() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=161, n=2800, noise=3e-3)
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_comparison_b() -> tuple[list[str], list[list[str]]]:
    time, inner, drag = _two_sensor(seed=171, n=2800, release=350, noise=9e-3)
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_realistic() -> tuple[list[str], list[list[str]]]:
    """Realistically sized run: 20 s at 1 kHz, both sensors."""
    time, inner, drag = _two_sensor(seed=181, n=20000, release=4000)
    return [T, INNER, DRAG], _cols(time, inner, drag)


def _f_crlf_quoted() -> tuple[list[str], list[list[str]]]:
    """Quoted headers containing commas, CRLF line endings."""
    time, inner, drag = _two_sensor(seed=191, n=1800)
    return ['"Time, (s)"', '"Accel 1, inner"', '"Accel 2, drag"'], _cols(time, inner, drag)


FIXTURES: list[Fixture] = [
    Fixture("normal_two_sensor_utf8", "Nominal two-sensor UTF-8 run", _f_normal, _base_config()),
    Fixture(
        "japanese_headers_utf8",
        "Japanese headers, UTF-8",
        _f_japanese,
        _base_config(
            time_column=T_JP,
            acceleration_column_inner_capsule=INNER_JP,
            acceleration_column_drag_shield=DRAG_JP,
        ),
    ),
    Fixture(
        "japanese_headers_cp932",
        "Japanese headers, CP932/Windows-31J",
        _f_japanese_cp932,
        _base_config(
            time_column=T_CP932,
            acceleration_column_inner_capsule=INNER_CP932,
            acceleration_column_drag_shield=DRAG_CP932,
        ),
        encoding="cp932",
    ),
    Fixture("inner_only", "Inner Capsule column only", _f_inner_only, _base_config(use_drag_acceleration=False)),
    Fixture("drag_only", "Drag Shield column only", _f_drag_only, _base_config(use_inner_acceleration=False)),
    Fixture("missing_sync_point", "No sample below sync threshold", _f_missing_sync, _base_config()),
    Fixture("sync_at_nonzero_index", "Sync found at a late index", _f_sync_nonzero, _base_config()),
    Fixture("nan_missing_samples", "NaN gaps in both sensors", _f_nan_samples, _base_config()),
    Fixture("inf_values", "+/-Inf samples treated as missing", _f_inf_values, _base_config()),
    Fixture("non_numeric_mixed", "Non-numeric cells coerced to missing", _f_non_numeric, _base_config()),
    Fixture("non_monotonic_time", "Time axis steps backwards", _f_non_monotonic, _base_config()),
    Fixture("duplicate_time", "Duplicate timestamps", _f_duplicate_time, _base_config()),
    Fixture("constant_window", "Exactly-constant window -> std 0", _f_constant_window, _base_config()),
    Fixture("large_dc_offset", "1e6 offset with 1e-6 variance", _f_large_dc_offset, _base_config()),
    Fixture("extreme_spike_positive", "1000 G positive spike", _f_spike_positive, _base_config()),
    Fixture("extreme_spike_negative", "1000 G negative spike", _f_spike_negative, _base_config()),
    Fixture("tie_equal_minimum", "Equal minima -> earliest window wins", _f_tie, _base_config()),
    Fixture("short_data", "Shorter than one window", _f_short_data, _base_config(), ranges=[(0.0, 0.03)]),
    Fixture("comparison_a", "Comparison dataset A", _f_comparison_a, _base_config()),
    Fixture("comparison_b", "Comparison dataset B", _f_comparison_b, _base_config()),
    Fixture("realistic_large", "20 s at 1 kHz", _f_realistic, _base_config(), ranges=[(0.2, 1.2), (0.0, 5.0)]),
    Fixture(
        "crlf_quoted_headers",
        "Quoted headers with commas, CRLF",
        _f_crlf_quoted,
        _base_config(
            time_column="Time, (s)",
            acceleration_column_inner_capsule="Accel 1, inner",
            acceleration_column_drag_shield="Accel 2, drag",
        ),
        newline="\r\n",
    ),
]
