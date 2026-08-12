"""Shared fixtures and the deterministic spec every visual test is built from.

`poster_renderer` is imported from `src/` without being installed, so the suite runs identically
from a checkout (`python3 -m pytest poster-renderer/tests`) and from inside the container image
(`python -m pytest /app/tests`, where `PYTHONPATH=/app/src`).
"""

from __future__ import annotations

import base64
import copy
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

REFERENCE_DIR = Path(__file__).resolve().parent / "reference"


def pytest_addoption(parser: pytest.Parser) -> None:
    """Register `--update-reference`, used to re-baseline the checked-in PNG.

    Regenerating is deliberately opt-in: the reference image is the record of
    what the poster contract looked like when it was last reviewed, so a render
    change must be seen and accepted by a person rather than silently absorbed
    on the next test run.
    """
    parser.addoption(
        "--update-reference",
        action="store_true",
        default=False,
        help="Rewrite the checked-in reference PNG from the current renderer output.",
    )


def encode_series(values: np.ndarray) -> dict[str, Any]:
    """Encode a float64 array the way `packages/plot-spec/src/wire.ts` does."""
    array = np.ascontiguousarray(values, dtype=np.dtype("<f8"))
    return {"data": base64.b64encode(array.tobytes()).decode("ascii"), "length": int(array.size)}


def deterministic_series(count: int = 1450) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A fixed, seeded stand-in for a drop-tower run.

    Mirrors the `deterministic_data` fixture of
    /home/user/AAT/tests/gui/test_export_graph_invariance.py: the same generator
    (`np.random.RandomState`), the same seed, the same shape of signal — a sampled sine plus
    Gaussian noise for each sensor. `RandomState` is the legacy generator precisely because its
    stream is frozen forever by NumPy's compatibility policy, so the fixture cannot drift with a
    NumPy upgrade.
    """
    rng = np.random.RandomState(20260725)
    time = np.arange(count) / 1000.0
    inner = 0.002 * np.sin(2 * np.pi * 3 * time) + rng.normal(0, 5e-4, count)
    drag = 0.004 * np.sin(2 * np.pi * 2 * time) + rng.normal(0, 8e-4, count)
    return time, inner, drag


def build_spec(**overrides: Any) -> dict[str, Any]:
    """A valid `both`-series spec, overridable field by field."""
    time, inner, drag = deterministic_series()
    spec: dict[str, Any] = {
        "analysisRevisionId": "rev_01JQ0000000000000000000000",
        "runCode": "260725a",
        "posterKind": "auto",
        "posterPresetVersion": "aat-poster-v1",
        "xMin": 0.0,
        "xMax": 1.45,
        "yMin": -0.02,
        "yMax": 0.02,
        "series": "both",
        "title": "",
        "showLegend": True,
        "figureWidth": 10.6,
        "figureHeight": 3.4,
        "dpi": 300,
        "data": {
            "inner": {"time": encode_series(time), "values": encode_series(inner)},
            "drag": {"time": encode_series(time), "values": encode_series(drag)},
        },
    }
    spec.update(copy.deepcopy(overrides))
    return spec


@pytest.fixture
def spec_dict() -> dict[str, Any]:
    return build_spec()


@pytest.fixture
def validated_spec(spec_dict: dict[str, Any]):
    from poster_renderer.validation import validate_spec

    return validate_spec(spec_dict)
