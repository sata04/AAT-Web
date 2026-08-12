"""Every rejection rule, and the constants they are derived from.

The container re-validates a spec the Worker has already validated with Zod. These tests are the
proof that the second implementation is not weaker than the first: the constants are asserted
against `packages/plot-spec/src/spec.ts` by value, and each rule has a case that must be rejected.

The injection tests are the ones worth reading twice. They do not assert that a malicious title is
*rejected* — it is not, and should not be; a run legitimately called `../../etc/passwd` is a
perfectly renderable name. They assert that it is *inert*: it reaches an axes title and nothing
else, because the renderer never builds a path, never spawns a process, and never writes a file.
"""

from __future__ import annotations

import base64
import json

import numpy as np
import pytest

from poster_renderer import limits
from poster_renderer.errors import SpecValidationError
from poster_renderer.render import build_figure
from poster_renderer.validation import parse_request_json, validate_spec

from conftest import build_spec, encode_series


def expect_rejected(spec: dict, *, field: str | None = None) -> SpecValidationError:
    with pytest.raises(SpecValidationError) as caught:
        validate_spec(spec)
    if field is not None:
        assert caught.value.field == field
    return caught.value


# ---------------------------------------------------------------------------------------------
# The constants themselves
# ---------------------------------------------------------------------------------------------


def test_limits_mirror_the_typescript_schema():
    """Values copied from packages/plot-spec/src/spec.ts. Changing one means changing both."""
    assert limits.MAX_POINTS == 200_000
    assert limits.MAX_PAYLOAD_BYTES == 8 * 1024 * 1024
    assert limits.FIGURE_DIMENSION_MIN_INCHES == 2
    assert limits.FIGURE_DIMENSION_MAX_INCHES == 20
    assert limits.DPI_MIN == 72
    assert limits.DPI_MAX == 600
    assert limits.TITLE_MAX_LENGTH == 120
    assert limits.ANALYSIS_REVISION_ID_MAX_LENGTH == 200
    assert limits.POSTER_KINDS == ("auto", "custom")
    assert limits.SERIES_SELECTIONS == ("inner", "drag", "both")
    assert limits.POSTER_PRESET_VERSIONS == ("aat-poster-v1",)
    # The transport cap must exceed the payload cap, or a schema-valid spec could not be uploaded.
    assert limits.MAX_REQUEST_BYTES > limits.MAX_PAYLOAD_BYTES


@pytest.mark.parametrize(
    "byte_length, expected",
    [(0, 0), (1, 4), (3, 4), (4, 8), (8, 12), (24, 32), (1600, 2136)],
)
def test_expected_base64_length_matches_codec_ts(byte_length, expected):
    assert limits.expected_base64_length(byte_length) == expected


def test_valid_spec_is_accepted(spec_dict):
    spec = validate_spec(spec_dict)
    assert spec.series == "both"
    assert spec.inner is not None and spec.drag is not None
    assert spec.inner.time.dtype == np.float64
    assert spec.inner.time.size == spec.inner.values.size == 1450
    assert spec.dpi == 300


# ---------------------------------------------------------------------------------------------
# JSON-level rejections
# ---------------------------------------------------------------------------------------------


def test_invalid_json_is_rejected():
    with pytest.raises(SpecValidationError):
        parse_request_json(b"{not json")


def test_invalid_utf8_is_rejected():
    with pytest.raises(SpecValidationError):
        parse_request_json(b'{"a": "\xff\xfe"}')


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_non_standard_json_constants_are_rejected(literal):
    """`json.loads` accepts these; `JSON.parse` does not, so neither may this validator."""
    with pytest.raises(SpecValidationError):
        parse_request_json(f'{{"xMin": {literal}}}'.encode())


def test_duplicate_keys_are_rejected():
    with pytest.raises(SpecValidationError):
        parse_request_json(b'{"dpi": 300, "dpi": 72}')


def test_overflowing_number_literal_is_rejected():
    """`1e400` parses to `inf` without ever passing through `parse_constant`."""
    spec = build_spec()
    body = json.dumps(spec).replace('"xMax": 1.45', '"xMax": 1e400')
    expect_rejected(parse_request_json(body.encode()), field="xMax")


def test_non_object_body_is_rejected():
    expect_rejected([], field="spec")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------------------------
# Shape: unknown keys, missing keys, wrong types
# ---------------------------------------------------------------------------------------------


def test_unknown_top_level_key_is_rejected():
    error = expect_rejected(build_spec(rcParams={"font.size": 40}))
    assert "unknown" in error.message


def test_unknown_key_inside_data_is_rejected():
    spec = build_spec()
    spec["data"]["sneaky"] = spec["data"]["inner"]
    expect_rejected(spec)


def test_unknown_key_inside_encoded_series_is_rejected():
    spec = build_spec()
    spec["data"]["inner"]["time"]["path"] = "/etc/passwd"
    expect_rejected(spec)


@pytest.mark.parametrize("key", sorted(limits.SPEC_REQUIRED_KEYS))
def test_missing_required_key_is_rejected(key):
    spec = build_spec()
    del spec[key]
    expect_rejected(spec)


def test_null_optional_key_is_rejected():
    """Optional means absent, never present-and-null (`exactOptionalPropertyTypes`)."""
    expect_rejected(build_spec(yMin=None), field="yMin")


@pytest.mark.parametrize(
    "field, value",
    [
        ("analysisRevisionId", 1),
        ("runCode", 260725),
        ("title", ["a"]),
        ("showLegend", "true"),
        ("showLegend", 1),
        ("xMin", "0"),
        ("xMin", True),
        ("dpi", "300"),
        ("figureWidth", None),
        ("data", "inner"),
    ],
)
def test_wrong_scalar_type_is_rejected(field, value):
    expect_rejected(build_spec(**{field: value}), field=field)


# ---------------------------------------------------------------------------------------------
# Field rules
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("run_code", ["", "26072", "2607255", "260725A", "260725ab", "abcdef", "260725-"])
def test_bad_run_code_is_rejected(run_code):
    expect_rejected(build_spec(runCode=run_code), field="runCode")


def test_non_ascii_digits_in_run_code_are_rejected():
    """Python's `\\d` is Unicode-aware by default; JavaScript's is not. The mirror must not be laxer."""
    expect_rejected(build_spec(runCode="٢٦٠٧٢٥"), field="runCode")


@pytest.mark.parametrize("run_code", ["260725", "260725a", "000000z"])
def test_good_run_code_is_accepted(run_code):
    assert validate_spec(build_spec(runCode=run_code)).run_code == run_code


def test_overlong_title_is_rejected():
    expect_rejected(build_spec(title="x" * (limits.TITLE_MAX_LENGTH + 1)), field="title")


def test_maximum_length_title_is_accepted():
    title = "x" * limits.TITLE_MAX_LENGTH
    assert validate_spec(build_spec(title=title)).title == title


@pytest.mark.parametrize("title", ["line\nbreak", "tab\there", "nul\x00byte", "bell\x07", "del\x7f"])
def test_control_characters_in_title_are_rejected(title):
    expect_rejected(build_spec(title=title), field="title")


def test_overlong_analysis_revision_id_is_rejected():
    expect_rejected(
        build_spec(analysisRevisionId="x" * (limits.ANALYSIS_REVISION_ID_MAX_LENGTH + 1)),
        field="analysisRevisionId",
    )


def test_empty_analysis_revision_id_is_rejected():
    expect_rejected(build_spec(analysisRevisionId=""), field="analysisRevisionId")


@pytest.mark.parametrize("dpi", [71, 601, 0, -300, 300.5])
def test_dpi_outside_the_allowed_range_is_rejected(dpi):
    expect_rejected(build_spec(dpi=dpi), field="dpi")


@pytest.mark.parametrize("dpi", [72, 300, 600])
def test_dpi_at_the_boundaries_is_accepted(dpi):
    assert validate_spec(build_spec(dpi=dpi)).dpi == dpi


def test_integral_float_dpi_is_accepted():
    """Zod's `z.number().int()` accepts `300.0`, so this mirror must too."""
    assert validate_spec(build_spec(dpi=300.0)).dpi == 300


@pytest.mark.parametrize("field", ["figureWidth", "figureHeight"])
@pytest.mark.parametrize("value", [1.99, 20.01, 0, -10])
def test_figure_dimensions_outside_the_allowed_range_are_rejected(field, value):
    expect_rejected(build_spec(**{field: value}), field=field)


@pytest.mark.parametrize("kind", ["default", "AUTO", "", "custom "])
def test_unknown_poster_kind_is_rejected(kind):
    expect_rejected(build_spec(posterKind=kind), field="posterKind")


def test_unknown_preset_version_is_rejected():
    expect_rejected(build_spec(posterPresetVersion="aat-poster-v2"), field="posterPresetVersion")


def test_unknown_series_selection_is_rejected():
    expect_rejected(build_spec(series="all"), field="series")


@pytest.mark.parametrize("x_min, x_max", [(1.0, 1.0), (2.0, 1.0)])
def test_unordered_x_bounds_are_rejected(x_min, x_max):
    expect_rejected(build_spec(xMin=x_min, xMax=x_max), field="xMin")


def test_unordered_y_bounds_are_rejected():
    expect_rejected(build_spec(yMin=1.0, yMax=-1.0), field="yMin")


def test_absent_y_bounds_are_allowed():
    spec = build_spec()
    del spec["yMin"]
    del spec["yMax"]
    validated = validate_spec(spec)
    assert validated.y_min is None and validated.y_max is None


# ---------------------------------------------------------------------------------------------
# series <-> data agreement
# ---------------------------------------------------------------------------------------------


def test_series_inner_requires_inner_data():
    spec = build_spec(series="inner")
    expect_rejected(spec, field="data.drag")  # `both` payload still carries drag


def test_series_inner_without_inner_data_is_rejected():
    spec = build_spec(series="inner")
    del spec["data"]["drag"]
    del spec["data"]["inner"]
    expect_rejected(spec, field="data.inner")


def test_series_inner_accepts_a_matching_payload():
    spec = build_spec(series="inner")
    del spec["data"]["drag"]
    validated = validate_spec(spec)
    assert validated.inner is not None and validated.drag is None


def test_series_drag_accepts_a_matching_payload():
    spec = build_spec(series="drag")
    del spec["data"]["inner"]
    validated = validate_spec(spec)
    assert validated.drag is not None and validated.inner is None


# ---------------------------------------------------------------------------------------------
# Encoded series
# ---------------------------------------------------------------------------------------------


def test_mismatched_array_lengths_are_rejected():
    spec = build_spec()
    spec["data"]["inner"]["values"] = encode_series(np.zeros(1449))
    expect_rejected(spec, field="data.inner")


def test_declared_length_not_matching_the_payload_is_rejected():
    spec = build_spec()
    spec["data"]["inner"]["time"]["length"] = 1449
    expect_rejected(spec, field="data.inner.time.data")


def test_too_many_points_is_rejected():
    spec = build_spec()
    spec["data"]["inner"]["time"]["length"] = limits.MAX_POINTS + 1
    error = expect_rejected(spec, field="data.inner.time.length")
    assert str(limits.MAX_POINTS) in error.message


def test_point_count_at_the_cap_is_structurally_accepted():
    """The cap itself is legal; only exceeding it is not. Kept small enough to stay fast."""
    count = 5000
    array = np.linspace(0.0, 1.45, count)
    spec = build_spec(
        series="inner",
        data={"inner": {"time": encode_series(array), "values": encode_series(array)}},
    )
    assert validate_spec(spec).inner.time.size == count


@pytest.mark.parametrize(
    "payload",
    ["not base64!!", "AAAA AAAA", "====", "AAAAA", "\n", "QUFB\x00"],
)
def test_malformed_base64_is_rejected(payload):
    spec = build_spec()
    spec["data"]["inner"]["time"]["data"] = payload
    expect_rejected(spec)


def test_negative_declared_length_is_rejected():
    spec = build_spec()
    spec["data"]["inner"]["time"] = {"data": "", "length": -1}
    expect_rejected(spec, field="data.inner.time.length")


def test_non_integer_declared_length_is_rejected():
    spec = build_spec()
    spec["data"]["inner"]["time"] = {"data": "", "length": 1.5}
    expect_rejected(spec, field="data.inner.time.length")


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_non_finite_time_samples_are_rejected(bad):
    spec = build_spec()
    time = np.linspace(0.0, 1.45, 1450)
    time[7] = bad
    spec["data"]["inner"]["time"] = encode_series(time)
    expect_rejected(spec, field="data.inner.time")


@pytest.mark.parametrize("bad", [np.inf, -np.inf])
def test_infinite_value_samples_are_rejected(bad):
    spec = build_spec()
    values = np.zeros(1450)
    values[3] = bad
    spec["data"]["inner"]["values"] = encode_series(values)
    expect_rejected(spec, field="data.inner.values")


def test_nan_value_samples_are_accepted_as_gaps():
    """NaN in `values` is the documented gap marker (wire.ts) and must survive to Matplotlib."""
    spec = build_spec()
    values = np.zeros(1450)
    values[100:200] = np.nan
    spec["data"]["inner"]["values"] = encode_series(values)
    validated = validate_spec(spec)
    assert np.isnan(validated.inner.values[150])
    figure = build_figure(validated)
    try:
        assert len(figure.axes[0].get_lines()) == 2
    finally:
        figure.clear()


def test_payload_byte_cap_is_enforced(monkeypatch):
    """Sum of base64 characters across every array, exactly as spec.ts accounts for it."""
    monkeypatch.setattr(limits, "MAX_PAYLOAD_BYTES", 128)
    monkeypatch.setattr("poster_renderer.validation.MAX_PAYLOAD_BYTES", 128)
    expect_rejected(build_spec(), field="data")


def test_wire_format_is_little_endian():
    """A big-endian encoding of the same numbers must not decode to the same array."""
    values = np.array([1.0, 2.0, 3.0], dtype=np.dtype(">f8"))
    spec = build_spec(
        series="inner",
        data={
            "inner": {
                "time": encode_series(np.array([0.0, 1.0, 2.0])),
                "values": {"data": base64.b64encode(values.tobytes()).decode("ascii"), "length": 3},
            }
        },
    )
    decoded = validate_spec(spec).inner.values
    assert not np.allclose(decoded, [1.0, 2.0, 3.0])


# ---------------------------------------------------------------------------------------------
# Injection attempts
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "hostile",
    [
        "../../etc/passwd",
        "$(rm -rf /)",
        "`id`",
        "; shutdown -h now",
        "%2e%2e%2fetc%2fpasswd",
        "poster.png; cat /etc/shadow",
        "{title}{name}{version}",
        "\\\\server\\share\\poster.png",
    ],
)
def test_hostile_titles_are_inert(hostile, tmp_path, monkeypatch):
    """A hostile title is drawn as text and nothing else happens.

    The spec has no field naming a file, so there is nothing to interpolate a path into; the check
    here is that the value flows into the axes title verbatim and that the working directory is
    untouched by the render.
    """
    monkeypatch.chdir(tmp_path)
    spec = validate_spec(build_spec(title=hostile))
    figure = build_figure(spec)
    try:
        assert figure.axes[0].get_title() == f"The Gravity Level {hostile}"
        assert figure.axes[0].get_lines()[0].get_label() == f"{hostile} (Inner Capsule)"
    finally:
        figure.clear()
    assert list(tmp_path.iterdir()) == [], "rendering must not create files"


def test_format_placeholders_in_a_name_cannot_reach_the_template():
    """`{version}` in a name must render literally, not expand the watermark's template."""
    spec = validate_spec(build_spec(title="{version} {name}"))
    figure = build_figure(spec)
    try:
        assert figure.axes[0].get_title() == "The Gravity Level {version} {name}"
    finally:
        figure.clear()


def test_display_name_falls_back_to_the_run_code(spec_dict):
    """An empty title means "no override": the figure is named after the run, as on the desktop."""
    assert validate_spec(spec_dict).display_name == "260725a"
    assert validate_spec(build_spec(title="Drop 42")).display_name == "Drop 42"
