#!/usr/bin/env python3
"""Differential test cases for the pairwise-summation kernel.

The golden fixtures exercise the reductions through the full pipeline, which is
the behaviour that matters — but they only reach the array lengths that real
analysis windows happen to produce. NumPy's pairwise summation changes algorithm
at n=8 and n=128 and recurses with a split rounded down to a multiple of 8, so
the interesting failure modes cluster around those boundaries.

This writes NumPy's answers for a spread of lengths and value distributions,
which `packages/analysis-core/test/numeric.golden.test.ts` then holds the
TypeScript kernel to, bit-for-bit.

Usage:
    python reference/python/generate_numeric_cases.py
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
TARGET = ROOT / "tests" / "golden" / "numeric-cases.json"

# Lengths chosen around NumPy's algorithm boundaries: the naive path (n < 8),
# the unrolled block path (n <= 128), and the recursive split (n > 128),
# including the values either side of each transition and lengths that are not
# multiples of 8 so the remainder loop is exercised.
LENGTHS = [1, 2, 7, 8, 9, 15, 16, 17, 120, 127, 128, 129, 130, 135, 136, 255, 256, 257, 1000, 4096]

DISTRIBUTIONS = {
    0: "standard normal",
    1: "1e6 offset with 1e-6 spread (catastrophic cancellation)",
    2: "exactly constant",
    3: "quiet noise with one 1e4 spike",
}


def build(kind: int, n: int, rng: np.random.RandomState) -> np.ndarray:
    if kind == 0:
        return rng.normal(0, 1, n)
    if kind == 1:
        return rng.normal(1e6, 1e-6, n)
    if kind == 2:
        # The same value a constant gravity window produces after conversion.
        return np.full(n, 0.125 / 9.797578)
    values = rng.normal(0, 0.01, n)
    if n > 3:
        values[n // 2] = 1e4
    return values


def main() -> int:
    rng = np.random.RandomState(4242)
    cases = []
    for n in LENGTHS:
        for kind in DISTRIBUTIONS:
            values = build(kind, n, rng)
            cases.append(
                {
                    "length": n,
                    "kind": kind,
                    "distribution": DISTRIBUTIONS[kind],
                    "data": base64.b64encode(values.astype("<f8").tobytes()).decode("ascii"),
                    "sum": float(np.sum(values)),
                    "mean": float(np.mean(values)),
                    "absMean": float(np.abs(values).mean()),
                    "std": float(np.std(values)),
                }
            )

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "description": "NumPy reduction results for the pairwise-summation differential test",
        "numpyVersion": np.__version__,
        "cases": cases,
    }
    TARGET.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} cases to {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
