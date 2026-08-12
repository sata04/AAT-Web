"""Pixel regression against a committed reference PNG.

`tests/reference/aat-poster-v1-gravity-level-72dpi.png` is the `aat-poster-v1` preset rendered
from the deterministic fixture in `conftest.py`. It is committed so that a change in Matplotlib,
NumPy, Pillow, FreeType, the font, or the base image shows up as a *picture* a reviewer can look
at, not only as a failed assertion about a hex colour.

**Byte equality is deliberately not asserted here.** Inside the pinned container image, repeated
renders are byte-identical (`test_determinism.py` proves that). Across operating systems and
library builds they are not, and requiring it would make the suite fail on a developer's Mac for
reasons that have nothing to do with the contract: FreeType's rasteriser and hinting differ
between builds, and zlib/libpng make different compression choices. So this test asserts what
actually has to hold everywhere — identical dimensions, and a perceptual difference small enough
that no researcher could tell the two figures apart — and leaves byte equality to the image.

Regenerate with:

    poster-renderer/.venv/bin/python -m pytest poster-renderer/tests/test_reference_image.py \
        --update-reference

and then *look at the new image* before committing it. Regenerating a reference to make a test
pass is exactly the mistake this file exists to prevent; see README.md.
"""

from __future__ import annotations

import io
import os

import numpy as np
import pytest
from PIL import Image

from poster_renderer.render import render_png
from poster_renderer.validation import validate_spec

from conftest import REFERENCE_DIR, build_spec

REFERENCE_DPI = 72
REFERENCE_NAME = "aat-poster-v1-gravity-level-72dpi.png"
REFERENCE_SIZE = (763, 244)  # 10.6in x 3.4in at 72 dpi

#: Mean absolute per-channel difference, 0-255. A different glyph rasteriser moves a handful of
#: edge pixels by a few levels; anything that moves a line, a colour or a layout blows past this.
MAX_MEAN_ABSOLUTE_DIFFERENCE = 1.0

#: Share of pixels allowed to differ by more than `PIXEL_TOLERANCE` on any channel.
PIXEL_TOLERANCE = 16
MAX_DIFFERING_PIXEL_FRACTION = 0.02


#: Set to "1" to additionally require byte-for-byte equality with the committed reference. Only
#: meaningful in an environment identical to the one the reference was generated in — see the test
#: below and README.md, "Reference images".
STRICT_BYTES_ENV = "POSTER_STRICT_REFERENCE_BYTES"


def render_reference_png() -> bytes:
    return render_png(validate_spec(build_spec(dpi=REFERENCE_DPI)))


@pytest.fixture(scope="module")
def rendered() -> bytes:
    return render_reference_png()


def test_reference_matches_current_render(request, rendered: bytes):
    reference_path = REFERENCE_DIR / REFERENCE_NAME

    if request.config.getoption("--update-reference"):
        reference_path.parent.mkdir(parents=True, exist_ok=True)
        reference_path.write_bytes(rendered)
        pytest.skip(f"reference updated: {reference_path} — review the image before committing")

    assert reference_path.is_file(), f"missing reference image: {reference_path}"

    expected = Image.open(io.BytesIO(reference_path.read_bytes())).convert("RGB")
    actual = Image.open(io.BytesIO(rendered)).convert("RGB")

    assert expected.size == REFERENCE_SIZE
    assert actual.size == expected.size, "figure geometry changed — this is a visual-contract break"

    expected_pixels = np.asarray(expected, dtype=np.int16)
    actual_pixels = np.asarray(actual, dtype=np.int16)
    difference = np.abs(actual_pixels - expected_pixels)

    mean_difference = float(difference.mean())
    differing = float((difference.max(axis=2) > PIXEL_TOLERANCE).mean())

    assert mean_difference <= MAX_MEAN_ABSOLUTE_DIFFERENCE, (
        f"mean pixel difference {mean_difference:.3f} exceeds {MAX_MEAN_ABSOLUTE_DIFFERENCE}; "
        "the rendered poster no longer matches the committed reference"
    )
    assert differing <= MAX_DIFFERING_PIXEL_FRACTION, (
        f"{differing:.2%} of pixels differ by more than {PIXEL_TOLERANCE} levels "
        f"(limit {MAX_DIFFERING_PIXEL_FRACTION:.0%})"
    )


@pytest.mark.skipif(
    os.environ.get(STRICT_BYTES_ENV) != "1",
    reason=(
        f"byte equality with the committed reference is only asserted when {STRICT_BYTES_ENV}=1, "
        "i.e. in an environment identical to the one that produced it"
    ),
)
def test_reference_is_byte_identical(rendered: bytes):
    """The sharp version of the check, for whoever regenerated the reference.

    Opt-in rather than default because the committed reference is produced on one machine, and
    demanding its exact bytes everywhere would fail for FreeType and zlib build differences that
    change nothing a reader could see. Turn it on when the reference was generated in the same
    image you are testing in, and it becomes the strictest possible visual-regression gate.
    """
    assert (REFERENCE_DIR / REFERENCE_NAME).read_bytes() == rendered
