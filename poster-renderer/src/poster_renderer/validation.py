"""Strict validation of an incoming poster plot spec.

This is a from-scratch reimplementation of `packages/plot-spec/src/spec.ts` (Zod). The Worker has
already validated the spec with that schema; this container validates it again anyway, because a
container must never treat its caller as trusted. Every limit it enforces lives in
:mod:`poster_renderer.limits`, so the two implementations can be reconciled by diffing constants.

Two differences from the Zod original, both deliberate:

  * Zod collects every issue; this raises on the first one. The Worker's copy of the schema is
    what produces a helpful multi-issue message for a human — by the time a request reaches the
    container, *any* failure is a bug on the caller's side and one precise reason is enough.
  * Error messages name the offending field and the rule it broke, and never quote the offending
    value. Nothing client-controlled is reflected back into a response or a log line.

The result is a frozen :class:`PosterPlotSpec` holding decoded NumPy arrays: past this module, no
part of the renderer ever sees a raw string or an untyped dict from the network.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

from . import preset
from .errors import SpecValidationError
from .limits import (
    ANALYSIS_REVISION_ID_MAX_LENGTH,
    ANALYSIS_REVISION_ID_MIN_LENGTH,
    CONTROL_CHARACTER_PATTERN,
    DPI_MAX,
    DPI_MIN,
    ENCODED_SERIES_KEYS,
    FIGURE_DIMENSION_MAX_INCHES,
    FIGURE_DIMENSION_MIN_INCHES,
    MAX_PAYLOAD_BYTES,
    MAX_POINTS,
    PLOT_DATA_KEYS,
    POSTER_KINDS,
    POSTER_PRESET_VERSIONS,
    RUN_CODE_PATTERN,
    SERIES_DATA_KEYS,
    SERIES_SELECTIONS,
    SPEC_ALLOWED_KEYS,
    SPEC_REQUIRED_KEYS,
    STRICT_BASE64_PATTERN,
    TITLE_MAX_LENGTH,
    expected_base64_length,
)

#: The wire dtype: little-endian IEEE-754 float64, matching `codec.ts`'s `DataView.setFloat64(...,
#: true)`. Spelling the byte order explicitly means the format does not silently inherit the
#: host's endianness on either side.
WIRE_DTYPE = np.dtype("<f8")


@dataclass(frozen=True)
class SeriesArrays:
    """One sensor's decoded `(time, values)` pair. Equal length, guaranteed by validation."""

    time: np.ndarray
    values: np.ndarray


@dataclass(frozen=True)
class PosterPlotSpec:
    """A validated spec. Every field is already range-checked, typed and decoded."""

    analysis_revision_id: str
    run_code: str
    poster_kind: str
    poster_preset_version: str
    x_min: float
    x_max: float
    y_min: float | None
    y_max: float | None
    series: str
    title: str
    show_legend: bool
    figure_width: float
    figure_height: float
    dpi: int
    inner: SeriesArrays | None
    drag: SeriesArrays | None

    @property
    def display_name(self) -> str:
        """The `{name}` substituted into the title and legend templates.

        The frozen contract draws the title as "The Gravity Level <name>" and the legend entries
        as "<name> (Inner Capsule)" / "<name> (Drag Shield)" — one name, three places. The desktop
        application passes its CSV basename, which for this project is exactly the run code
        ("260811a"), so `runCode` is the default.

        `title` is the caller's optional override of that name (an empty string means "no
        override"), which is why the spec caps it at 120 characters and forbids control characters
        rather than treating it as free-form typography. It replaces the *name*, never the title
        template: a formal poster's title always reads "The Gravity Level ...", which is the whole
        point of it being formal.
        """
        return self.title if self.title else self.run_code


# ---------------------------------------------------------------------------------------------
# JSON parsing
# ---------------------------------------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise SpecValidationError(
        "request body contains a non-standard JSON constant (NaN, Infinity or -Infinity)"
    )


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            raise SpecValidationError("request body contains a duplicate object key", field=key)
        seen[key] = value
    return seen


def parse_request_json(raw: bytes) -> Any:
    """Parse a request body as strict JSON.

    Python's `json` is laxer than `JSON.parse` in two ways that matter for a validator mirroring a
    JavaScript schema, and both are closed here:

      * it accepts the literals `NaN`, `Infinity` and `-Infinity`, which JSON does not have and
        `JSON.parse` rejects — so a client could otherwise smuggle a non-finite axis bound past a
        `isinstance(value, float)` check;
      * it silently keeps the *last* of a set of duplicate keys, which lets one serialiser's view
        of a document differ from another's.
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise SpecValidationError("request body is not valid UTF-8") from None
    try:
        return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_reject_duplicate_keys)
    except SpecValidationError:
        raise
    except ValueError:
        raise SpecValidationError("request body is not valid JSON") from None


# ---------------------------------------------------------------------------------------------
# Leaf validators
# ---------------------------------------------------------------------------------------------


def _object(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise SpecValidationError(f"{field} must be an object", field=field)
    return value


def _exact_keys(
    value: Mapping[str, Any],
    allowed: frozenset[str],
    required: frozenset[str],
    prefix: str,
    label: str | None = None,
) -> None:
    """Enforce a Zod `.strict()` object: no unknown keys, no missing required keys.

    `prefix` is the reported field path (empty at the top level, so a bad top-level key is
    reported as `dpi` rather than `spec.dpi` — the same paths `spec.ts` produces); `label` is what
    the message calls the object.
    """
    name = label if label is not None else prefix
    keys = set(value)
    unknown = sorted(keys - allowed)
    if unknown:
        raise SpecValidationError(
            f"{name} contains unknown key(s): {', '.join(unknown)}",
            field=f"{prefix}.{unknown[0]}" if prefix else unknown[0],
        )
    missing = sorted(required - keys)
    if missing:
        raise SpecValidationError(
            f"{name} is missing required key(s): {', '.join(missing)}",
            field=f"{prefix}.{missing[0]}" if prefix else missing[0],
        )


def _string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise SpecValidationError(f"{field} must be a string", field=field)
    return value


def _bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise SpecValidationError(f"{field} must be a boolean", field=field)
    return value


def _number(value: Any, field: str) -> float:
    # `bool` is a subclass of `int` in Python but not a number in JSON, so it is excluded first.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SpecValidationError(f"{field} must be a number", field=field)
    number = float(value)
    # `json.loads("1e400")` yields `inf` without going through `parse_constant`, so finiteness is
    # checked on the value rather than only on the literal.
    if not math.isfinite(number):
        raise SpecValidationError(f"{field} must be a finite number", field=field)
    return number


def _integer(value: Any, field: str) -> int:
    """Accept a JSON number with no fractional part.

    Zod's `z.number().int()` accepts `300.0` because JavaScript has one number type; `json.loads`
    turns the same literal into a Python `float`. Rejecting floats here would make the container
    stricter than the schema it mirrors and reject specs the Worker considers valid.
    """
    number = _number(value, field)
    if not float(number).is_integer():
        raise SpecValidationError(f"{field} must be an integer", field=field)
    return int(number)


def _bounded(value: float, minimum: float, maximum: float, field: str) -> float:
    if value < minimum or value > maximum:
        raise SpecValidationError(f"{field} must be between {minimum} and {maximum}", field=field)
    return value


def _enum(value: Any, allowed: tuple[str, ...], field: str) -> str:
    text = _string(value, field)
    if text not in allowed:
        raise SpecValidationError(f"{field} must be one of: {', '.join(allowed)}", field=field)
    return text


# ---------------------------------------------------------------------------------------------
# Encoded series
# ---------------------------------------------------------------------------------------------


def _decode_series(value: Any, field: str) -> tuple[np.ndarray, int]:
    """Validate and decode one `{data, length}` envelope, returning `(array, wire_byte_count)`."""
    envelope = _object(value, field)
    _exact_keys(envelope, ENCODED_SERIES_KEYS, ENCODED_SERIES_KEYS, field)

    declared_length = envelope["length"]
    if isinstance(declared_length, bool) or not isinstance(declared_length, int):
        raise SpecValidationError(f"{field}.length must be a non-negative integer", field=f"{field}.length")
    if declared_length < 0:
        raise SpecValidationError(f"{field}.length must be a non-negative integer", field=f"{field}.length")
    if declared_length > MAX_POINTS:
        raise SpecValidationError(
            f"{field}.length exceeds the {MAX_POINTS}-point cap", field=f"{field}.length"
        )

    encoded = _string(envelope["data"], f"{field}.data")
    if not STRICT_BASE64_PATTERN.fullmatch(encoded):
        raise SpecValidationError(
            f"{field}.data must be standard base64 (alphabet and padding only, no whitespace)",
            field=f"{field}.data",
        )
    if len(encoded) != expected_base64_length(declared_length * 8):
        raise SpecValidationError(
            f"{field}.data length does not match the declared element count "
            f"(a float64 series of n elements encodes to exactly ceil(n * 8 / 3) * 4 characters)",
            field=f"{field}.data",
        )

    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise SpecValidationError(f"{field}.data is not decodable base64", field=f"{field}.data") from None
    if len(raw) != declared_length * 8:
        raise SpecValidationError(
            f"{field}.data decodes to the wrong number of bytes for its declared length",
            field=f"{field}.data",
        )

    # `np.array(...)` copies out of the read-only bytes object, giving an owned, writable array
    # that survives the buffer and can be pickled to the render worker without surprises.
    array = np.array(np.frombuffer(raw, dtype=WIRE_DTYPE), dtype=np.float64)
    return array, len(encoded)


def _series_entry(value: Any, key: str) -> tuple[SeriesArrays, int]:
    field = f"data.{key}"
    entry = _object(value, field)
    _exact_keys(entry, SERIES_DATA_KEYS, SERIES_DATA_KEYS, field)

    time, time_bytes = _decode_series(entry["time"], f"{field}.time")
    values, values_bytes = _decode_series(entry["values"], f"{field}.values")

    if time.size != values.size:
        raise SpecValidationError(
            f"{field}.time and {field}.values must have equal length", field=field
        )

    # `time` is an axis, so every sample must be a real instant: a gap is expressed by the *value*
    # at an instant being absent, never by the instant itself being undefined (see wire.ts).
    if time.size and not bool(np.isfinite(time).all()):
        raise SpecValidationError(
            f"{field}.time must contain only finite samples; NaN and Infinity are not allowed in time",
            field=f"{field}.time",
        )
    # NaN is the documented gap marker in `values` and is allowed through to Matplotlib, which
    # draws it as a break in the line. An infinite gravity level never is.
    if values.size and bool(np.isinf(values).any()):
        raise SpecValidationError(
            f"{field}.values must contain only finite samples or NaN (a gap); "
            f"+/-Infinity is not allowed",
            field=f"{field}.values",
        )

    return SeriesArrays(time=time, values=values), time_bytes + values_bytes


# ---------------------------------------------------------------------------------------------
# Top level
# ---------------------------------------------------------------------------------------------


def validate_spec(value: Any) -> PosterPlotSpec:
    """Validate a parsed JSON document as a poster plot spec, or raise :class:`SpecValidationError`."""
    document = _object(value, "spec")
    _exact_keys(document, SPEC_ALLOWED_KEYS, SPEC_REQUIRED_KEYS, "", label="spec")

    analysis_revision_id = _string(document["analysisRevisionId"], "analysisRevisionId")
    if not (
        ANALYSIS_REVISION_ID_MIN_LENGTH <= len(analysis_revision_id) <= ANALYSIS_REVISION_ID_MAX_LENGTH
    ):
        raise SpecValidationError(
            f"analysisRevisionId must be between {ANALYSIS_REVISION_ID_MIN_LENGTH} and "
            f"{ANALYSIS_REVISION_ID_MAX_LENGTH} characters",
            field="analysisRevisionId",
        )

    run_code = _string(document["runCode"], "runCode")
    if not RUN_CODE_PATTERN.fullmatch(run_code):
        raise SpecValidationError(
            "runCode must be six ASCII digits optionally followed by one lowercase letter",
            field="runCode",
        )

    poster_kind = _enum(document["posterKind"], POSTER_KINDS, "posterKind")
    poster_preset_version = _enum(
        document["posterPresetVersion"], POSTER_PRESET_VERSIONS, "posterPresetVersion"
    )

    title = _string(document["title"], "title")
    if len(title) > TITLE_MAX_LENGTH:
        raise SpecValidationError(
            f"title must be at most {TITLE_MAX_LENGTH} characters", field="title"
        )
    if CONTROL_CHARACTER_PATTERN.search(title):
        raise SpecValidationError(
            "title must not contain control characters or newlines", field="title"
        )

    x_min = _number(document["xMin"], "xMin")
    x_max = _number(document["xMax"], "xMax")
    if x_min >= x_max:
        raise SpecValidationError("xMin must be less than xMax", field="xMin")

    # Optional in the Zod sense: absent, never present-and-null (`exactOptionalPropertyTypes`).
    y_min = _number(document["yMin"], "yMin") if "yMin" in document else None
    y_max = _number(document["yMax"], "yMax") if "yMax" in document else None
    # Checked on the *resolved* pair, because an omitted bound is drawn at the preset's rather than
    # autoscaled (see `render.build_figure`). Checking only the both-present case — which is what a
    # literal reading of the Zod schema used to be — would accept `yMin: 1.5` with no `yMax`, whose
    # resolved range is `(1.5, 1.0)`; Matplotlib accepts an inverted `set_ylim` silently and draws
    # the gravity axis upside down. `spec.ts` carries the same rule.
    #
    # `preset` rather than `limits` because these are the frozen figure's bounds, not a defensive
    # cap. Only one preset version exists, so there is nothing to look up by name yet; when there
    # is, this resolves through the spec's `posterPresetVersion` the way the TypeScript does.
    resolved_y_min = preset.DEFAULT_Y_MIN if y_min is None else y_min
    resolved_y_max = preset.DEFAULT_Y_MAX if y_max is None else y_max
    if resolved_y_min >= resolved_y_max:
        if y_min is not None and y_max is not None:
            raise SpecValidationError("yMin must be less than yMax", field="yMin")
        raise SpecValidationError(
            "yMin must be less than yMax once the omitted bound takes the preset's",
            field="yMin" if y_min is not None else "yMax",
        )

    series = _enum(document["series"], SERIES_SELECTIONS, "series")
    show_legend = _bool(document["showLegend"], "showLegend")

    figure_width = _bounded(
        _number(document["figureWidth"], "figureWidth"),
        FIGURE_DIMENSION_MIN_INCHES,
        FIGURE_DIMENSION_MAX_INCHES,
        "figureWidth",
    )
    figure_height = _bounded(
        _number(document["figureHeight"], "figureHeight"),
        FIGURE_DIMENSION_MIN_INCHES,
        FIGURE_DIMENSION_MAX_INCHES,
        "figureHeight",
    )
    dpi = int(_bounded(_integer(document["dpi"], "dpi"), DPI_MIN, DPI_MAX, "dpi"))

    data = _object(document["data"], "data")
    _exact_keys(data, PLOT_DATA_KEYS, frozenset(), "data")

    requires_inner = series in ("inner", "both")
    requires_drag = series in ("drag", "both")
    for key, required in (("inner", requires_inner), ("drag", requires_drag)):
        present = key in data
        if required and not present:
            raise SpecValidationError(f'series "{series}" requires data.{key}', field=f"data.{key}")
        if not required and present:
            raise SpecValidationError(
                f'series "{series}" must not include data.{key}', field=f"data.{key}"
            )

    inner: SeriesArrays | None = None
    drag: SeriesArrays | None = None
    wire_bytes = 0
    if requires_inner:
        inner, inner_bytes = _series_entry(data["inner"], "inner")
        wire_bytes += inner_bytes
    if requires_drag:
        drag, drag_bytes = _series_entry(data["drag"], "drag")
        wire_bytes += drag_bytes

    if wire_bytes > MAX_PAYLOAD_BYTES:
        raise SpecValidationError(
            f"encoded series payload exceeds the {MAX_PAYLOAD_BYTES}-byte cap", field="data"
        )

    return PosterPlotSpec(
        analysis_revision_id=analysis_revision_id,
        run_code=run_code,
        poster_kind=poster_kind,
        poster_preset_version=poster_preset_version,
        x_min=x_min,
        x_max=x_max,
        y_min=y_min,
        y_max=y_max,
        series=series,
        title=title,
        show_legend=show_legend,
        figure_width=figure_width,
        figure_height=figure_height,
        dpi=dpi,
        inner=inner,
        drag=drag,
    )


__all__ = [
    "PosterPlotSpec",
    "SeriesArrays",
    "parse_request_json",
    "validate_spec",
]
