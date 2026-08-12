#!/usr/bin/env python3
"""Python oracle — writes CSV fixtures and golden analysis results.

This runs the *vendored, unmodified* AAT desktop core (``reference/python/core``)
over every fixture in ``fixtures.py`` and records what it produced. The
TypeScript port in ``packages/analysis-core`` is then held to these results.

Outputs
    tests/fixtures/csv/<name>.csv      exact bytes the TS suite parses
    tests/golden/<name>.json           scalars, indices, metadata, array refs
    tests/golden/arrays/<sha>.f64      little-endian float64 payloads
    tests/golden/index.json            manifest

Float64 arrays go to raw binary rather than JSON so the values are bit-exact
and the repository stays small (8 bytes/sample instead of ~20 characters).
Scalars stay in JSON: Python's float repr round-trips exactly, and JavaScript
parses that same shortest representation back to the identical double.

Usage:
    python reference/python/generate_golden.py            # write everything
    python reference/python/generate_golden.py --check    # fail if stale
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from core.data_processor import (  # noqa: E402
    detect_columns,
    filter_data,
    load_and_process_data,
)
from core.statistics import calculate_range_statistics, calculate_statistics  # noqa: E402
from fixtures import FIXTURES, Fixture  # noqa: E402

CSV_DIR = ROOT / "tests" / "fixtures" / "csv"
GOLDEN_DIR = ROOT / "tests" / "golden"
ARRAY_DIR = GOLDEN_DIR / "arrays"

# The engine version stamped into every golden file. Bump when the *reference*
# semantics change; the TypeScript engine records the same value in provenance.
ANALYSIS_ENGINE_VERSION = "1.0.0"
GOLDEN_FORMAT_VERSION = 1


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def write_array(values: Any) -> dict[str, Any] | None:
    """Persist a float64 array as content-addressed binary, return a reference."""
    if values is None:
        return None
    array = np.asarray(values, dtype=np.float64).ravel()
    payload = array.astype("<f8").tobytes()
    digest = hashlib.sha256(payload).hexdigest()
    ARRAY_DIR.mkdir(parents=True, exist_ok=True)
    target = ARRAY_DIR / f"{digest}.f64"
    if not target.exists():
        target.write_bytes(payload)
    finite = np.isfinite(array)
    return {
        "file": f"arrays/{digest}.f64",
        "sha256": digest,
        "length": int(array.size),
        # Cheap human-readable sanity fields — the binary remains authoritative.
        "finiteCount": int(finite.sum()),
        "nanCount": int(np.isnan(array).sum()),
        "posInfCount": int(np.isposinf(array).sum()),
        "negInfCount": int(np.isneginf(array).sum()),
    }


def scalar(value: Any) -> Any:
    """JSON-safe scalar: NaN/Inf become tagged strings, None stays null."""
    if value is None:
        return None
    if isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int, np.integer)):
        return int(value)
    number = float(value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    return number


def series_or_none(series: pd.Series | None) -> Any:
    if series is None or len(series) == 0:
        return None
    return series.to_numpy(dtype=np.float64)


# ---------------------------------------------------------------------------
# G-quality — mirrors gui/workers.py:GQualityWorker.run without Qt
# ---------------------------------------------------------------------------


def g_quality_sweep(
    filtered_time: pd.Series,
    filtered_inner: pd.Series,
    filtered_drag: pd.Series,
    filtered_adjusted_time: pd.Series,
    config: dict[str, Any],
) -> list[tuple]:
    sampling_rate = float(config["sampling_rate"])
    length_inner = len(filtered_inner)
    length_drag = len(filtered_drag)
    has_inner = length_inner > 0
    has_drag = length_drag > 0

    start = float(config["g_quality_start"])
    end = float(config["g_quality_end"])
    step = float(config["g_quality_step"])
    tolerance = np.finfo(float).eps * max(1.0, abs(start), abs(end), abs(step)) * 8
    window_sizes = np.arange(start, end + tolerance, step)
    window_sizes = window_sizes[window_sizes <= end + tolerance]
    window_sizes = np.minimum(window_sizes, end)

    min_window_samples = max(1, round(start * sampling_rate))
    if not has_inner and not has_drag:
        return []
    enough = (has_inner and length_inner >= min_window_samples) or (has_drag and length_drag >= min_window_samples)
    if not enough:
        return []

    rows: list[tuple] = []
    for window_size in window_sizes:
        inner_mean = inner_time = inner_std = None
        drag_mean = drag_time = drag_std = None
        window_samples = max(1, round(window_size * sampling_rate))

        if has_inner and length_inner >= window_samples:
            inner_mean, inner_time, inner_std = calculate_statistics(
                filtered_inner, filtered_time, {"window_size": window_size, "sampling_rate": sampling_rate}
            )
        if has_drag and length_drag >= window_samples:
            drag_mean, drag_time, drag_std = calculate_statistics(
                filtered_drag, filtered_adjusted_time, {"window_size": window_size, "sampling_rate": sampling_rate}
            )

        if any(value is not None for value in (inner_mean, drag_mean)):
            rows.append(
                (
                    float(window_size),
                    inner_time,
                    inner_mean,
                    inner_std,
                    drag_time,
                    drag_mean,
                    drag_std,
                )
            )
    return rows


# ---------------------------------------------------------------------------
# Fixture execution
# ---------------------------------------------------------------------------


def write_csv(fixture: Fixture) -> Path:
    header, columns = fixture.build()
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    path = CSV_DIR / f"{fixture.name}.csv"
    rows = [",".join(header)]
    row_count = len(columns[0]) if columns else 0
    for index in range(row_count):
        rows.append(",".join(column[index] for column in columns))
    text = fixture.newline.join(rows) + fixture.newline
    path.write_bytes(text.encode(fixture.encoding))
    return path


def run_fixture(fixture: Fixture) -> dict[str, Any]:
    csv_path = write_csv(fixture)
    config = dict(fixture.config)
    record: dict[str, Any] = {
        "goldenFormatVersion": GOLDEN_FORMAT_VERSION,
        "analysisEngineVersion": ANALYSIS_ENGINE_VERSION,
        "name": fixture.name,
        "description": fixture.description,
        "csv": f"csv/{fixture.name}.csv",
        "csvEncoding": fixture.encoding,
        "csvSha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        "config": {key: scalar(value) for key, value in config.items()},
    }

    # --- column detection ---------------------------------------------------
    try:
        raw = pd.read_csv(csv_path, encoding=fixture.encoding)
    except UnicodeDecodeError:
        raw = pd.read_csv(csv_path, encoding="cp932")
    time_candidates, accel_candidates = detect_columns(str(csv_path), raw)
    record["detectedColumns"] = {"time": time_candidates, "acceleration": accel_candidates}

    # --- load / sync / gravity ---------------------------------------------
    inner_time, inner_gravity, drag_gravity, drag_time = load_and_process_data(str(csv_path), config, raw)

    # Recompute the sync indices the same way load_and_process_data does so the
    # golden file records them explicitly (the function itself only logs them).
    record["sync"] = compute_sync_indices(raw, config)

    record["arrays"] = {
        "innerAdjustedTime": write_array(series_or_none(inner_time)),
        "dragAdjustedTime": write_array(series_or_none(drag_time)),
        "innerGravity": write_array(series_or_none(inner_gravity)),
        "dragGravity": write_array(series_or_none(drag_gravity)),
    }

    # --- filtering ----------------------------------------------------------
    (
        filtered_time,
        filtered_inner,
        filtered_drag,
        filtered_adjusted_time,
        end_index,
    ) = filter_data(inner_time, inner_gravity, drag_gravity, drag_time, config)

    record["filter"] = {
        "endIndex": int(end_index),
        "innerLength": int(len(filtered_inner)),
        "dragLength": int(len(filtered_drag)),
        # Index of the first retained sample within the unfiltered series.
        "innerStartIndex": int(filtered_inner.index[0]) if len(filtered_inner) else None,
        "innerEndIndex": int(filtered_inner.index[-1]) if len(filtered_inner) else None,
        "dragStartIndex": int(filtered_drag.index[0]) if len(filtered_drag) else None,
        "dragEndIndex": int(filtered_drag.index[-1]) if len(filtered_drag) else None,
    }
    record["arrays"].update(
        {
            "filteredTime": write_array(series_or_none(filtered_time)),
            "filteredAdjustedTime": write_array(series_or_none(filtered_adjusted_time)),
            "filteredInnerGravity": write_array(series_or_none(filtered_inner)),
            "filteredDragGravity": write_array(series_or_none(filtered_drag)),
        }
    )

    # --- min-stddev statistics ---------------------------------------------
    def stats_for(values: pd.Series, times: pd.Series) -> dict[str, Any]:
        if len(values) == 0:
            return {"mean": None, "startTime": None, "std": None}
        mean, start_time, std = calculate_statistics(values, times, config)
        return {"mean": scalar(mean), "startTime": scalar(start_time), "std": scalar(std)}

    record["statistics"] = {
        "inner": stats_for(filtered_inner, filtered_time),
        "drag": stats_for(filtered_drag, filtered_adjusted_time),
    }

    # --- G-quality ----------------------------------------------------------
    rows = g_quality_sweep(filtered_time, filtered_inner, filtered_drag, filtered_adjusted_time, config)
    record["gQuality"] = [
        {
            "windowSize": scalar(row[0]),
            "innerStartTime": scalar(row[1]),
            "innerMean": scalar(row[2]),
            "innerStd": scalar(row[3]),
            "dragStartTime": scalar(row[4]),
            "dragMean": scalar(row[5]),
            "dragStd": scalar(row[6]),
        }
        for row in rows
    ]

    # --- range statistics ---------------------------------------------------
    range_records = []
    for xmin, xmax in fixture.ranges:
        inner_mask = (filtered_time >= xmin) & (filtered_time <= xmax)
        drag_mask = (filtered_adjusted_time >= xmin) & (filtered_adjusted_time <= xmax)
        inner_selected = filtered_inner[inner_mask].values if len(filtered_inner) else np.array([])
        drag_selected = filtered_drag[drag_mask].values if len(filtered_drag) else np.array([])
        range_records.append(
            {
                "xMin": scalar(xmin),
                "xMax": scalar(xmax),
                "inner": {k: scalar(v) for k, v in calculate_range_statistics(inner_selected).items()},
                "drag": {k: scalar(v) for k, v in calculate_range_statistics(drag_selected).items()},
            }
        )
    record["rangeStatistics"] = range_records

    return record


def compute_sync_indices(raw: pd.DataFrame, config: dict[str, Any]) -> dict[str, Any]:
    """Reproduce the sync-point selection of load_and_process_data.

    Kept deliberately close to the reference source: the fallback chain
    (inner borrows drag's index, otherwise sample 0) is part of the contract.
    """
    use_inner = config.get("use_inner_acceleration", True)
    use_drag = config.get("use_drag_acceleration", True)
    threshold = config.get("acceleration_threshold", 1.0)

    time = pd.to_numeric(raw[config["time_column"]], errors="coerce").astype(float)
    time_invalid = ~np.isfinite(time.to_numpy(dtype=float))

    def prepared(column_name: str, invert: bool) -> pd.Series:
        if column_name not in raw:
            return pd.Series(dtype=float)
        series = pd.to_numeric(raw[column_name], errors="coerce").astype(float)
        if time_invalid.any():
            series = series.mask(time_invalid)
        return -series if invert else series

    inner = (
        prepared(config["acceleration_column_inner_capsule"], bool(config.get("invert_inner_acceleration", False)))
        if use_inner
        else pd.Series(dtype=float)
    )
    drag = prepared(config["acceleration_column_drag_shield"], False) if use_drag else pd.Series(dtype=float)

    drag_hits = np.where(np.abs(drag) < threshold)[0] if use_drag and not drag.empty else np.array([])
    inner_hits = np.where(np.abs(inner) < threshold)[0] if use_inner and not inner.empty else np.array([])

    drag_index = int(drag_hits[0]) if len(drag_hits) else 0
    inner_index = int(inner_hits[0]) if len(inner_hits) else 0
    inner_fallback = None
    if use_inner and len(inner_hits) == 0 and len(drag_hits) > 0:
        inner_index = drag_index
        inner_fallback = "borrowed-drag"
    elif use_inner and len(inner_hits) == 0:
        inner_fallback = "first-sample"
    drag_fallback = "first-sample" if use_drag and len(drag_hits) == 0 else None

    return {
        "innerIndex": inner_index if use_inner else None,
        "dragIndex": drag_index if use_drag else None,
        "innerFallback": inner_fallback,
        "dragFallback": drag_fallback,
        "innerCandidateCount": int(len(inner_hits)),
        "dragCandidateCount": int(len(drag_hits)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if any golden file would change")
    parser.add_argument("--only", help="run a single fixture by name")
    args = parser.parse_args()

    # The reference core logs a lot of expected warnings for the adversarial
    # fixtures (missing sync, NaN rows). Keep the generator output readable.
    logging.getLogger().setLevel(logging.ERROR)
    os.environ.setdefault("AAT_LOG_LEVEL", "ERROR")

    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    changed: list[str] = []

    for fixture in FIXTURES:
        if args.only and fixture.name != args.only:
            continue
        record = run_fixture(fixture)
        target = GOLDEN_DIR / f"{fixture.name}.json"
        serialised = json.dumps(record, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        previous = target.read_text(encoding="utf-8") if target.exists() else None
        if previous != serialised:
            changed.append(fixture.name)
            if not args.check:
                target.write_text(serialised, encoding="utf-8")
        manifest.append(
            {
                "name": fixture.name,
                "description": fixture.description,
                "golden": f"{fixture.name}.json",
                "csv": record["csv"],
                "csvSha256": record["csvSha256"],
                "encoding": fixture.encoding,
            }
        )
        print(f"  {fixture.name}: {len(record['gQuality'])} g-quality rows, end index {record['filter']['endIndex']}")

    index_path = GOLDEN_DIR / "index.json"
    if args.only:
        # A single-fixture run knows nothing about the others; rewriting the
        # manifest from it would silently drop every fixture the suite expects.
        print(f"\nRewrote {args.only} only; index.json left untouched.")
        return 0

    index_payload = (
        json.dumps(
            {
                "goldenFormatVersion": GOLDEN_FORMAT_VERSION,
                "analysisEngineVersion": ANALYSIS_ENGINE_VERSION,
                "referenceCommit": (HERE / "REFERENCE_COMMIT.txt").read_text().strip(),
                "fixtures": manifest,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    if args.check:
        if index_path.read_text(encoding="utf-8") != index_payload:
            changed.append("index.json")
        if changed:
            print(f"\nSTALE golden files: {', '.join(changed)}", file=sys.stderr)
            return 1
        print("\nGolden files are up to date.")
        return 0

    index_path.write_text(index_payload, encoding="utf-8")
    print(f"\nWrote {len(manifest)} fixtures to {GOLDEN_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
