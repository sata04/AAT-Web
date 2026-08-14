"""The FROZEN visual contract for `aat-poster-v1`.

Every constant in this module was read off the desktop application's export path, not guessed.
The sources of truth, all verified line by line:

  * /home/user/AAT/gui/plot_controller.py
      - `_get_export_palette()`            -> ("#FFFFFF", "#FFFFFF", "#1F2328", "#656D76", "#D0D7DE")
      - `plot_gravity_level()` export branch -> figure/axes facecolor, line colours + linewidth 0.8,
        axis limits, title/label strings, `legend()`, `tight_layout()`, `savefig(...)` kwargs
      - `_apply_export_theme()`            -> spines, ticks, label/title colours, grid, legend frame
      - `_add_version_watermark()`         -> "AAT v{version}" at axes (0.98, 0.02), right/bottom,
                                              fontsize 8, colour "#656D76"
  * /home/user/AAT/gui/styles.py           -> `Colors.LIGHT_GRAPH_*` frozen colour constants
  * /home/user/AAT/tests/gui/test_export_graph_invariance.py
                                           -> the assertions that freeze all of the above
  * /home/user/AAT-Web/packages/plot-spec/src/presets.ts
                                           -> the TypeScript mirror of this same preset

The desktop deliberately draws the *saved* image with a fixed light palette regardless of the GUI
theme (`test_screen_theme_changes_do_not_touch_export_palette`). This renderer has no UI at all,
which makes that invariant structural rather than merely tested: there is no theme to depend on.

Changing anything in this module changes the pixels of every future poster. It must instead ship
as a NEW preset version so already-stored posters keep rendering the way they always have.
"""

from __future__ import annotations

from typing import Final

PRESET_VERSION: Final = "aat-poster-v1"

# --- Palette -----------------------------------------------------------------------------------
# PlotController._get_export_palette() returns (bg_primary, bg_secondary, text_primary,
# text_secondary, border); the export path uses bg_secondary for both the figure and the axes.
FIGURE_FACE_COLOR: Final = "#FFFFFF"
AXES_FACE_COLOR: Final = "#FFFFFF"
TEXT_PRIMARY_COLOR: Final = "#1F2328"  # axis labels + title
TEXT_SECONDARY_COLOR: Final = "#656D76"  # ticks, grid, watermark
BORDER_COLOR: Final = "#D0D7DE"  # spines, legend frame edge

# --- Series lines (Colors.LIGHT_GRAPH_* in gui/styles.py) ---------------------------------------
INNER_LINE_COLOR: Final = "#0969DA"  # Colors.LIGHT_GRAPH_INNER_MEAN
DRAG_LINE_COLOR: Final = "#CF222E"  # Colors.LIGHT_GRAPH_DRAG_MEAN
LINE_WIDTH: Final = 0.8  # EXPORT_LINEWIDTH_GL

# --- Grid --------------------------------------------------------------------------------------
GRID_LINE_STYLE: Final = "--"
GRID_ALPHA: Final = 0.3
GRID_COLOR: Final = TEXT_SECONDARY_COLOR

# --- Labels ------------------------------------------------------------------------------------
TITLE_TEMPLATE: Final = "The Gravity Level {name}"
X_LABEL: Final = "Time (s)"
Y_LABEL: Final = "Gravity Level (G)"
INNER_LEGEND_TEMPLATE: Final = "{name} (Inner Capsule)"
DRAG_LEGEND_TEMPLATE: Final = "{name} (Drag Shield)"

# --- Watermark ---------------------------------------------------------------------------------
WATERMARK_TEMPLATE: Final = "AAT v{version}"
WATERMARK_X: Final = 0.98
WATERMARK_Y: Final = 0.02
WATERMARK_HORIZONTAL_ALIGNMENT: Final = "right"
WATERMARK_VERTICAL_ALIGNMENT: Final = "bottom"
WATERMARK_FONT_SIZE: Final = 8
WATERMARK_COLOR: Final = TEXT_SECONDARY_COLOR

# --- Geometry / output -------------------------------------------------------------------------
# config/config.default.json: export_figure_width / export_figure_height / export_dpi /
# export_bbox_inches, default_graph_duration for the x-range, and ylim_min / ylim_max for the
# y-range.
DEFAULT_FIGURE_WIDTH_INCHES: Final = 10.6
DEFAULT_FIGURE_HEIGHT_INCHES: Final = 3.4
DEFAULT_DPI: Final = 300
DEFAULT_X_MIN: Final = 0.0
DEFAULT_X_MAX: Final = 1.45

# The gravity-level frame, in G. `plot_gravity_level` calls
# `set_ylim(config["ylim_min"], config["ylim_max"])` unconditionally — there is no path through the
# desktop application where the y-axis of a gravity-level figure autoscales, so a spec that omits
# its bounds gets these rather than Matplotlib's view of the data. See `render.build_figure`.
DEFAULT_Y_MIN: Final = -1.0
DEFAULT_Y_MAX: Final = 1.0
BBOX_INCHES: Final = None  # export_bbox_inches is null; "tight" would change the image geometry
TIGHT_LAYOUT: Final = True

# The DPI the Figure is *constructed* with, which is NOT the DPI it is saved at.
#
# This is subtle and load-bearing. The desktop builds its export figure with
# `plt.figure(figsize=(w, h))` — no `dpi` argument — so the figure carries `rcParams["figure.dpi"]`
# (Matplotlib's default, 100.0). `tight_layout()` then measures text with a renderer at *that*
# DPI and bakes the resulting subplot geometry into the figure; only afterwards does
# `savefig(dpi=300)` re-rasterise. Constructing the figure at 300 instead would lay the axes out
# against differently-rounded text extents and shift every element by a fraction of an inch.
#
# So: layout happens at 100 DPI, rasterisation at the spec's DPI. Do not "simplify" this.
LAYOUT_DPI: Final = 100.0

# --- Font --------------------------------------------------------------------------------------
# Pinned explicitly rather than left to font auto-discovery. DejaVu Sans ships inside the
# Matplotlib wheel, so this resolves to a file whose bytes are pinned by the Matplotlib version —
# no system font package, no fontconfig, no dependence on what happens to be installed in the
# image. These values happen to equal Matplotlib's own defaults, which is the point: naming them
# means a stray `matplotlibrc` or a future default change cannot move the glyphs.
FONT_FAMILY: Final = "sans-serif"
FONT_SANS_SERIF: Final = ("DejaVu Sans",)
MATH_FONT_SET: Final = "dejavusans"

#: rcParams applied to every render. Deliberately tiny: everything else is passed explicitly at
#: the call site so the drawing code reads the same way the desktop's export branch does.
FROZEN_RC_PARAMS: Final = {
    "font.family": FONT_FAMILY,
    "font.sans-serif": list(FONT_SANS_SERIF),
    "mathtext.fontset": MATH_FONT_SET,
    # Matplotlib would otherwise consult the process locale when formatting tick labels.
    "axes.formatter.use_locale": False,
    # Belt and braces: no interactive backend may be selected mid-process.
    "interactive": False,
}
