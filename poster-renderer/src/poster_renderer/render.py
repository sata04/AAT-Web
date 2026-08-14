"""Figure construction and PNG rasterisation.

The drawing order below is the desktop application's export branch
(`gui/plot_controller.py::plot_gravity_level`, the `save_graph` half) step for step. Order is not
cosmetic: `legend()` before `_apply_export_theme` is what lets the theme recolour the legend
frame, the watermark is added before `tight_layout()` so the layout accounts for it, and
`tight_layout()` runs at the *layout* DPI while `savefig` rasterises at the spec's DPI.

Nothing here reads the environment, the filesystem or the clock. Given the same
:class:`~poster_renderer.validation.PosterPlotSpec`, this module produces the same bytes.
"""

from __future__ import annotations

import io

import matplotlib
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure

from . import preset
from .validation import PosterPlotSpec, SeriesArrays
from .version import DESKTOP_BASELINE_VERSION, RENDERER_VERSION

# Applied once, process-wide, at import. The client cannot reach rcParams — the spec has no field
# that maps to one — so this is the only place Matplotlib's global configuration is ever touched.
matplotlib.rcParams.update(preset.FROZEN_RC_PARAMS)

#: PNG text chunks written into every render. Fixed strings only: no timestamp, no hostname, no
#: request identifier. Matplotlib would otherwise autogenerate a `Software` chunk naming its own
#: version, which would make the PNG bytes change on a Matplotlib upgrade even when not a single
#: pixel moved. Nothing here is derived from the request, so identical input gives identical bytes.
PNG_METADATA = {"Software": f"AAT poster-renderer {RENDERER_VERSION} ({preset.PRESET_VERSION})"}


def _apply_export_theme(axes, legend) -> None:
    """Port of `PlotController._apply_export_theme` (single-axes case).

    The desktop takes these colours from `_get_export_palette()`, a static white-background
    palette that is deliberately independent of the GUI theme. Here they are module constants —
    the renderer has no theme to be independent of.
    """
    axes.set_facecolor(preset.AXES_FACE_COLOR)
    for spine in axes.spines.values():
        spine.set_color(preset.BORDER_COLOR)
    axes.tick_params(colors=preset.TEXT_SECONDARY_COLOR, which="both")
    axes.xaxis.label.set_color(preset.TEXT_PRIMARY_COLOR)
    axes.yaxis.label.set_color(preset.TEXT_PRIMARY_COLOR)
    axes.title.set_color(preset.TEXT_PRIMARY_COLOR)
    axes.grid(True, linestyle=preset.GRID_LINE_STYLE, alpha=preset.GRID_ALPHA, color=preset.GRID_COLOR)

    if legend is not None:
        frame = legend.get_frame()
        frame.set_facecolor(preset.AXES_FACE_COLOR)
        frame.set_edgecolor(preset.BORDER_COLOR)
        for text in legend.get_texts():
            text.set_color(preset.TEXT_PRIMARY_COLOR)


def _add_version_watermark(axes) -> None:
    """Port of `PlotController._add_version_watermark`, called with the fixed export colour."""
    axes.text(
        preset.WATERMARK_X,
        preset.WATERMARK_Y,
        preset.WATERMARK_TEMPLATE.format(version=DESKTOP_BASELINE_VERSION),
        transform=axes.transAxes,
        fontsize=preset.WATERMARK_FONT_SIZE,
        verticalalignment=preset.WATERMARK_VERTICAL_ALIGNMENT,
        horizontalalignment=preset.WATERMARK_HORIZONTAL_ALIGNMENT,
        color=preset.WATERMARK_COLOR,
    )


def _plot_series(axes, series: SeriesArrays, label: str, color: str) -> None:
    axes.plot(series.time, series.values, label=label, color=color, linewidth=preset.LINE_WIDTH)


def build_figure(spec: PosterPlotSpec) -> Figure:
    """Build the poster figure. Separated from :func:`render_png` so tests can inspect the artists.

    The caller owns the returned figure and should drop it once done; it is deliberately created
    without `pyplot`, so it is not registered in any global figure manager and nothing needs to
    close it to avoid a leak.
    """
    figure = Figure(figsize=(spec.figure_width, spec.figure_height), dpi=preset.LAYOUT_DPI)
    # Attaching the Agg canvas explicitly: a bare `Figure` has no canvas, and `tight_layout()`
    # needs a renderer. This is also the guarantee that no other backend can be involved.
    FigureCanvasAgg(figure)
    figure.patch.set_facecolor(preset.FIGURE_FACE_COLOR)

    axes = figure.add_subplot(111)
    name = spec.display_name

    # The templates are module constants and the untrusted name is an *argument*, so a name
    # containing braces cannot alter the format string.
    if spec.inner is not None:
        _plot_series(axes, spec.inner, preset.INNER_LEGEND_TEMPLATE.format(name=name), preset.INNER_LINE_COLOR)
    if spec.drag is not None:
        _plot_series(axes, spec.drag, preset.DRAG_LEGEND_TEMPLATE.format(name=name), preset.DRAG_LINE_COLOR)

    # Both axes are always bounded, exactly as the desktop's export branch bounds them. The spec's
    # y-bounds are *optional on the wire* — `spec.ts` has always allowed them to be absent, and
    # specs stored before the builder started resolving them still are — so an absent bound falls
    # back to the preset's `ylim_min`/`ylim_max` rather than to Matplotlib's autoscaling. There is
    # no branch in `plot_gravity_level` that autoscales a gravity-level figure, so there must be
    # none here: an autoscaled poster frames every drop to its own noise, which makes two figures
    # side by side uncomparable while looking perfectly correct on its own.
    axes.set_ylim(
        preset.DEFAULT_Y_MIN if spec.y_min is None else spec.y_min,
        preset.DEFAULT_Y_MAX if spec.y_max is None else spec.y_max,
    )
    axes.set_xlim(spec.x_min, spec.x_max)

    axes.set_title(preset.TITLE_TEMPLATE.format(name=name))
    axes.set_xlabel(preset.X_LABEL)
    axes.set_ylabel(preset.Y_LABEL)

    legend = axes.legend() if spec.show_legend else None

    _apply_export_theme(axes, legend)
    _add_version_watermark(axes)
    figure.tight_layout()

    return figure


def render_png(spec: PosterPlotSpec) -> bytes:
    """Render a validated spec to PNG bytes.

    Writes into an in-memory buffer. The renderer never constructs a filesystem path, so no field
    of the spec — least of all the title or run code — can influence where anything is written.
    """
    figure = build_figure(spec)
    try:
        buffer = io.BytesIO()
        figure.savefig(
            buffer,
            format="png",
            dpi=spec.dpi,
            bbox_inches=preset.BBOX_INCHES,
            facecolor=preset.FIGURE_FACE_COLOR,
            metadata=PNG_METADATA,
        )
        return buffer.getvalue()
    finally:
        figure.clear()


__all__ = ["PNG_METADATA", "build_figure", "render_png"]
