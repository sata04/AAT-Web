"""Every hard limit and enum the renderer enforces, in one module.

These mirror `packages/plot-spec/src/spec.ts` exactly. The Worker validates a spec with Zod
before it ever reaches this container, and this container validates it again from scratch —
the container must never assume its caller is honest, and the duplication is the point.

Because there are two implementations of one contract, the constants live here alone (not
scattered through the validation code) so reconciling them against `spec.ts` is a diff of two
short files. `tests/test_validation.py` asserts each value; if `spec.ts` moves, this module and
that test are what must move with it.
"""

from __future__ import annotations

import re
from typing import Final

# --- Mirrors of packages/plot-spec/src/spec.ts --------------------------------------------------

#: spec.ts MAX_POINTS — per-array sample cap (time and values, per series).
MAX_POINTS: Final = 200_000

#: spec.ts MAX_PAYLOAD_BYTES — total base64 *character* count across every array in `data`.
MAX_PAYLOAD_BYTES: Final = 8 * 1024 * 1024

#: spec.ts FIGURE_DIMENSION_MIN_INCHES / FIGURE_DIMENSION_MAX_INCHES.
FIGURE_DIMENSION_MIN_INCHES: Final = 2.0
FIGURE_DIMENSION_MAX_INCHES: Final = 20.0

#: spec.ts DPI_MIN / DPI_MAX.
DPI_MIN: Final = 72
DPI_MAX: Final = 600

#: spec.ts TITLE_MAX_LENGTH.
TITLE_MAX_LENGTH: Final = 120

#: spec.ts `analysisRevisionId: z.string().min(1).max(200)`.
ANALYSIS_REVISION_ID_MIN_LENGTH: Final = 1
ANALYSIS_REVISION_ID_MAX_LENGTH: Final = 200

#: spec.ts RUN_CODE_PATTERN. `re.ASCII` matters: Python's `\d` matches Unicode decimal digits
#: (e.g. Arabic-Indic "٢٦٠٨١١") by default, which JavaScript's `\d` never does. Without the flag
#: this validator would be *laxer* than the Zod schema it mirrors.
RUN_CODE_PATTERN: Final = re.compile(r"^\d{6}[a-z]?$", re.ASCII)

#: spec.ts CONTROL_CHARACTER_PATTERN — C0 controls plus DEL. Newlines are control characters and
#: are therefore rejected in a title, which also removes any log-injection vector.
CONTROL_CHARACTER_PATTERN: Final = re.compile(r"[\x00-\x1f\x7f]")

#: codec.ts STRICT_BASE64_PATTERN — standard alphabet, correct padding, no whitespace.
STRICT_BASE64_PATTERN: Final = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

#: spec.ts PosterKindSchema.
POSTER_KINDS: Final = ("auto", "custom")

#: spec.ts SeriesSelectionSchema.
SERIES_SELECTIONS: Final = ("inner", "drag", "both")

#: presets.ts POSTER_PRESET_VERSIONS.
POSTER_PRESET_VERSIONS: Final = ("aat-poster-v1",)

#: The exact set of top-level keys a spec may carry. Anything else is rejected (`.strict()`).
SPEC_REQUIRED_KEYS: Final = frozenset(
    {
        "analysisRevisionId",
        "runCode",
        "posterKind",
        "posterPresetVersion",
        "xMin",
        "xMax",
        "series",
        "title",
        "showLegend",
        "figureWidth",
        "figureHeight",
        "dpi",
        "data",
    }
)
SPEC_OPTIONAL_KEYS: Final = frozenset({"yMin", "yMax"})
SPEC_ALLOWED_KEYS: Final = SPEC_REQUIRED_KEYS | SPEC_OPTIONAL_KEYS

SERIES_DATA_KEYS: Final = frozenset({"time", "values"})
ENCODED_SERIES_KEYS: Final = frozenset({"data", "length"})
PLOT_DATA_KEYS: Final = frozenset({"inner", "drag"})

# --- HTTP transport limits (this service's own, not spec.ts's) ----------------------------------

#: Slack allowed for the JSON envelope around the base64 arrays: keys, punctuation, the scalar
#: fields and the run/title strings. A spec whose arrays sit exactly on MAX_PAYLOAD_BYTES is
#: valid, so the body cap has to be strictly larger than MAX_PAYLOAD_BYTES or the transport would
#: reject specs the schema accepts. 64 KiB is ~200x the largest possible envelope.
MAX_ENVELOPE_OVERHEAD_BYTES: Final = 64 * 1024

#: Hard cap on the HTTP request body, enforced from `Content-Length` *before* a single byte of
#: the body is read and again while reading, so an over-long or lying body is never buffered.
MAX_REQUEST_BYTES: Final = MAX_PAYLOAD_BYTES + MAX_ENVELOPE_OVERHEAD_BYTES


def expected_base64_length(byte_length: int) -> int:
    """Length of standard, padded base64 for `byte_length` bytes (codec.ts expectedBase64Length)."""
    return -(-byte_length // 3) * 4
