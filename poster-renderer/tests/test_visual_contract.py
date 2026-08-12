"""The frozen visual contract.

This is a port of /home/user/AAT/tests/gui/test_export_graph_invariance.py — the suite that
freezes what the desktop application's exported PNG looks like. Every assertion there about the
Gravity Level export figure has a counterpart here, against the same values.

The desktop version has to work hard to prove one thing this renderer gets structurally: that the
saved image does not depend on the GUI theme. There is no GUI here, so instead we prove the
equivalent for the only ambient state that could still leak in — Matplotlib's global rcParams —
by rendering under a dark palette and requiring byte-identical output.

If an assertion in this file fails, the correct response is never to update the expected value. It
is to work out which dependency changed the pixels and review the visual diff (see README.md).
"""

from __future__ import annotations

import io

import matplotlib
import pytest
from matplotlib.figure import Figure
from PIL import Image

from poster_renderer import preset
from poster_renderer.render import build_figure, render_png
from poster_renderer.validation import validate_spec
from poster_renderer.version import APP_VERSION

from conftest import build_spec

# The frozen values, restated here as literals rather than imported from `preset`, so that a typo
# or a "helpful" edit in the preset module is caught instead of being silently agreed with. These
# match EXPORT_* in the desktop suite and Colors.LIGHT_GRAPH_* in gui/styles.py.
EXPORT_FACECOLOR = "#FFFFFF"
EXPORT_LINEWIDTH_GL = 0.8
EXPORT_TEXT_PRIMARY = "#1F2328"
EXPORT_TEXT_SECONDARY = "#656D76"
EXPORT_BORDER = "#D0D7DE"
LIGHT_GRAPH_INNER_MEAN = "#0969DA"
LIGHT_GRAPH_DRAG_MEAN = "#CF222E"


def to_hex(color) -> str:
    return matplotlib.colors.to_hex(color).upper()


@pytest.fixture
def figure(validated_spec):
    built = build_figure(validated_spec)
    try:
        yield built
    finally:
        built.clear()


def test_preset_constants_are_frozen():
    """The preset module still says what gui/styles.py and plot_controller.py say."""
    assert preset.PRESET_VERSION == "aat-poster-v1"
    assert preset.FIGURE_FACE_COLOR == EXPORT_FACECOLOR
    assert preset.AXES_FACE_COLOR == EXPORT_FACECOLOR
    assert preset.INNER_LINE_COLOR == LIGHT_GRAPH_INNER_MEAN
    assert preset.DRAG_LINE_COLOR == LIGHT_GRAPH_DRAG_MEAN
    assert preset.LINE_WIDTH == EXPORT_LINEWIDTH_GL
    assert preset.TEXT_PRIMARY_COLOR == EXPORT_TEXT_PRIMARY
    assert preset.TEXT_SECONDARY_COLOR == EXPORT_TEXT_SECONDARY
    assert preset.BORDER_COLOR == EXPORT_BORDER
    assert preset.TITLE_TEMPLATE == "The Gravity Level {name}"
    assert preset.X_LABEL == "Time (s)"
    assert preset.Y_LABEL == "Gravity Level (G)"
    assert preset.INNER_LEGEND_TEMPLATE == "{name} (Inner Capsule)"
    assert preset.DRAG_LEGEND_TEMPLATE == "{name} (Drag Shield)"
    assert preset.WATERMARK_TEMPLATE == "AAT v{version}"
    assert (preset.WATERMARK_X, preset.WATERMARK_Y) == (0.98, 0.02)
    assert preset.WATERMARK_FONT_SIZE == 8
    assert preset.WATERMARK_COLOR == EXPORT_TEXT_SECONDARY
    assert preset.GRID_LINE_STYLE == "--"
    assert preset.GRID_ALPHA == 0.3
    assert preset.GRID_COLOR == EXPORT_TEXT_SECONDARY
    assert preset.BBOX_INCHES is None
    assert preset.TIGHT_LAYOUT is True
    # config/config.default.json
    assert preset.DEFAULT_FIGURE_WIDTH_INCHES == 10.6
    assert preset.DEFAULT_FIGURE_HEIGHT_INCHES == 3.4
    assert preset.DEFAULT_DPI == 300
    assert (preset.DEFAULT_X_MIN, preset.DEFAULT_X_MAX) == (0.0, 1.45)
    # Matplotlib's own figure.dpi default: tight_layout must measure at 100, not at the save DPI.
    assert preset.LAYOUT_DPI == 100.0


def test_figure_geometry_and_background(figure: Figure):
    assert tuple(figure.get_size_inches()) == (10.6, 3.4)
    assert to_hex(figure.patch.get_facecolor()) == EXPORT_FACECOLOR
    # Laid out at 100 DPI regardless of the DPI the PNG is rasterised at (see preset.LAYOUT_DPI).
    assert figure.dpi == preset.LAYOUT_DPI


def test_axes_limits_title_and_labels(figure: Figure):
    (axes,) = figure.axes
    assert axes.get_xlim() == (0.0, 1.45)
    assert axes.get_ylim() == (-0.02, 0.02)
    assert axes.get_title() == "The Gravity Level 260725a"
    assert axes.get_xlabel() == "Time (s)"
    assert axes.get_ylabel() == "Gravity Level (G)"
    assert to_hex(axes.get_facecolor()) == EXPORT_FACECOLOR
    assert to_hex(axes.title.get_color()) == EXPORT_TEXT_PRIMARY
    assert to_hex(axes.xaxis.label.get_color()) == EXPORT_TEXT_PRIMARY
    assert to_hex(axes.yaxis.label.get_color()) == EXPORT_TEXT_PRIMARY


def test_series_lines(figure: Figure):
    (axes,) = figure.axes
    lines = axes.get_lines()
    assert len(lines) == 2
    assert [to_hex(line.get_color()) for line in lines] == [LIGHT_GRAPH_INNER_MEAN, LIGHT_GRAPH_DRAG_MEAN]
    assert [line.get_linewidth() for line in lines] == [EXPORT_LINEWIDTH_GL, EXPORT_LINEWIDTH_GL]
    assert [line.get_label() for line in lines] == [
        "260725a (Inner Capsule)",
        "260725a (Drag Shield)",
    ]


def test_legend_frame_and_text(figure: Figure):
    (axes,) = figure.axes
    legend = axes.get_legend()
    assert legend is not None
    assert to_hex(legend.get_frame().get_facecolor()) == EXPORT_FACECOLOR
    assert to_hex(legend.get_frame().get_edgecolor()) == EXPORT_BORDER
    assert {to_hex(text.get_color()) for text in legend.get_texts()} == {EXPORT_TEXT_PRIMARY}
    assert [text.get_text() for text in legend.get_texts()] == [
        "260725a (Inner Capsule)",
        "260725a (Drag Shield)",
    ]


def test_legend_can_be_suppressed():
    spec = validate_spec(build_spec(showLegend=False))
    built = build_figure(spec)
    try:
        (axes,) = built.axes
        assert axes.get_legend() is None
        # Suppressing the legend must not disturb anything else about the frozen contract.
        assert axes.get_title() == "The Gravity Level 260725a"
        assert len(axes.get_lines()) == 2
    finally:
        built.clear()


def test_spines_ticks_and_grid(figure: Figure):
    (axes,) = figure.axes
    assert {to_hex(spine.get_edgecolor()) for spine in axes.spines.values()} == {EXPORT_BORDER}

    tick_colors = set()
    for axis in (axes.xaxis, axes.yaxis):
        for tick in axis.get_major_ticks():
            tick_colors.add(to_hex(tick.tick1line.get_color()))
            tick_colors.add(to_hex(tick.label1.get_color()))
    assert tick_colors == {EXPORT_TEXT_SECONDARY}

    gridlines = axes.xaxis.get_gridlines() + axes.yaxis.get_gridlines()
    assert gridlines, "the export theme always turns the grid on"
    for gridline in gridlines:
        assert gridline.get_visible()
        assert gridline.get_linestyle() == "--"
        assert gridline.get_alpha() == 0.3
        assert to_hex(gridline.get_color()) == EXPORT_TEXT_SECONDARY


def test_version_watermark(figure: Figure):
    (axes,) = figure.axes
    watermarks = [text for text in axes.texts if text.get_text().startswith("AAT v")]
    assert len(watermarks) == 1, "the version watermark is missing"
    watermark = watermarks[0]
    assert watermark.get_text() == f"AAT v{APP_VERSION}"
    assert watermark.get_position() == (0.98, 0.02)
    assert watermark.get_transform() is axes.transAxes
    assert watermark.get_horizontalalignment() == "right"
    assert watermark.get_verticalalignment() == "bottom"
    assert watermark.get_fontsize() == 8
    assert to_hex(watermark.get_color()) == EXPORT_TEXT_SECONDARY


def test_font_is_pinned_not_discovered(figure: Figure):
    """The glyphs come from the DejaVu Sans that ships inside the Matplotlib wheel."""
    assert matplotlib.rcParams["font.family"] == ["sans-serif"]
    assert matplotlib.rcParams["font.sans-serif"] == ["DejaVu Sans"]
    (axes,) = figure.axes
    assert axes.title.get_fontfamily() == ["sans-serif"]


def test_backend_is_agg(figure: Figure):
    """Never an interactive backend, and above all never WebAgg (which would open a socket)."""
    assert matplotlib.get_backend().lower() == "agg"
    assert type(figure.canvas).__name__ == "FigureCanvasAgg"


def test_savefig_arguments(validated_spec, monkeypatch):
    """Capture the savefig call, exactly as the desktop suite's `_capture_export_figure` does."""
    captured: dict = {}
    original = Figure.savefig

    def spy(self, target, **kwargs):
        captured["figure"] = self
        captured["kwargs"] = dict(kwargs)
        return original(self, target, **kwargs)

    monkeypatch.setattr(Figure, "savefig", spy)
    render_png(validated_spec)

    kwargs = captured["kwargs"]
    assert kwargs["dpi"] == 300
    assert kwargs["bbox_inches"] is None
    assert str(kwargs["facecolor"]).upper() == EXPORT_FACECOLOR
    assert kwargs["format"] == "png"
    # Fixed metadata: no timestamp, nothing derived from the request.
    assert set(kwargs["metadata"]) == {"Software"}
    assert "Creation Time" not in kwargs["metadata"]


@pytest.mark.parametrize(
    ("dpi", "width", "height"),
    [(300, 10.6, 3.4), (100, 10.6, 3.4), (72, 8.0, 4.0), (600, 4.0, 2.0)],
)
def test_png_pixel_dimensions_follow_dpi_and_figsize(dpi, width, height):
    spec = validate_spec(build_spec(dpi=dpi, figureWidth=width, figureHeight=height))
    image = Image.open(io.BytesIO(render_png(spec)))
    assert image.size == (round(width * dpi), round(height * dpi))
    assert image.format == "PNG"


def test_output_is_independent_of_ambient_rcparams(validated_spec):
    """The renderer's analogue of "the export is identical across GUI themes".

    The desktop proves this by flipping the Qt theme; here the only ambient state that could
    reach a figure is Matplotlib's global configuration, so we set every colour rcParam to the
    dark palette from gui/styles.py and require the bytes not to move.
    """
    baseline = render_png(validated_spec)

    dark_palette = {
        "figure.facecolor": "#0D1117",
        "figure.edgecolor": "#0D1117",
        "axes.facecolor": "#0D1117",
        "axes.edgecolor": "#30363D",
        "axes.labelcolor": "#E6EDF3",
        "axes.titlecolor": "#E6EDF3",
        "text.color": "#E6EDF3",
        "xtick.color": "#8B949E",
        "ytick.color": "#8B949E",
        "xtick.labelcolor": "#8B949E",
        "ytick.labelcolor": "#8B949E",
        "grid.color": "#30363D",
        "legend.facecolor": "#161B22",
        "legend.edgecolor": "#30363D",
        "savefig.facecolor": "#0D1117",
        "savefig.edgecolor": "#0D1117",
        "lines.color": "#58A6FF",
    }
    with matplotlib.rc_context(dark_palette):
        themed = render_png(validated_spec)

    assert themed == baseline, "the poster changed with an ambient theme; the export must be fixed"
