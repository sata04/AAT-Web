# Migration from the desktop application

AAT Web is a rewrite, not a port with a compatibility shim. This document says
exactly what carries over, what does not, and why.

## Summary

| Desktop artefact | What happens |
| --- | --- |
| `config.json` (user settings) | **Imported.** Automatic migration with a report of anything dropped or defaulted. |
| CSV source files | **Unchanged.** Same files, same columns, same encodings. |
| `results_AAT/*.xlsx` | Not imported. Regenerating from the CSV is exact and takes seconds. |
| `results_AAT/cache/*.pickle`, `*_raw.h5` | **Deliberately not imported.** See below. |
| `results_AAT/graphs/*.png` | Not imported. The formal poster renderer reproduces them. |
| Filename conventions (`260812_data.csv`) | **Recognised** and used to pre-fill run metadata. |

## Settings

`migrateDesktopConfig()` in `@aat/shared` accepts a desktop `config.json`
verbatim — all keys snake_case, including `app_version` and anything a newer
desktop build added.

It is deliberately forgiving. An invalid value falls back to the default **with
a warning** rather than throwing, because a config that fails to load is a
config the user cannot fix without editing JSON by hand. Unknown keys are
preserved rather than discarded, so a round trip does not lose settings a future
version cares about.

The defaults themselves are unchanged from `config/config.default.json`:

```
sampling_rate 1000            gravity_constant 9.797578
acceleration_threshold 5.0    end_gravity_level 8.0
window_size 0.1               min_seconds_after_start 0.7
g_quality_start 0.1           g_quality_end 1.0        g_quality_step 0.05
ylim_min -1.0                 ylim_max 1.0
default_graph_duration 1.45   graph_sensor_mode both
export_figure_width 10.6      export_figure_height 3.4
export_dpi 300                export_bbox_inches null
invert_inner_acceleration true
```

Column-name settings (`time_column`,
`acceleration_column_inner_capsule`, `acceleration_column_drag_shield`) migrate
too, so a lab whose instrument writes a fixed header keeps working without
touching the column selector.

### Where settings live now

The desktop app stored config per OS (`~/Library/Application Support/AAT/`,
`%APPDATA%\AAT\`, `$XDG_CONFIG_HOME/AAT/`). The browser has no equivalent, so
settings live in IndexedDB, scoped to the origin. Consequences worth knowing:

- Clearing site data clears settings. Export the config first if that matters.
- Settings do not follow the user between browsers or machines. When signed in,
  the analysis config used for each revision is recorded in that revision's
  provenance, which is the part that actually matters for reproducibility.

## Cache

The desktop cache (`results_AAT/cache/*.pickle` and `*_raw.h5`) is **not**
imported, and this is a decision rather than an omission:

1. **A cache is not research data.** Every value in it is derived from the CSV
   and the configuration, both of which you still have. Nothing is lost.
2. **Pickle is an executable format.** Loading one is arbitrary code execution
   by design. Building an importer would mean adding a code-execution path to a
   browser application in order to avoid recomputing something that takes
   seconds.
3. **HDF5 in a browser** means shipping a WASM build of libhdf5 for a
   throwaway benefit.

Re-analysing the CSV produces bit-identical results — that is what the golden
suite in `docs/numerical-compatibility.md` verifies.

The web cache keys on `SHA-256(source) + config hash + engine version + cache
format version` rather than on filename and modification time, so a renamed file
is recognised as the same data and a touched file is not treated as new.

## Existing Excel output

Old `results_AAT/*.xlsx` files are not imported. AAT Web reproduces the same
workbook — same four sheets, same headers, same semantics — from the CSV.

One deliberate difference: where the desktop app would build a frame too large
for a worksheet and fail confusingly, AAT Web refuses up front with
`EXPORT_TOO_LARGE`, names the row counts, and offers CSV. See
`docs/numerical-compatibility.md`.

## Filenames and run identity

Experiment files commonly look like:

```
260812_data.csv      → run code 260812   (2026-08-12)
260811a_data.csv     → run code 260811a  (2026-08-11, first run)
260811b_data.csv     → run code 260811b  (2026-08-11, second run)
```

`260811a` and `260811b` are **separate runs** — two physical drops on the same
day — not two analyses of one run.

The convention is a **suggestion, never a requirement**:

- A matching filename pre-fills run code and experiment date.
- A non-matching filename analyses exactly the same; run metadata can be entered
  by hand.
- The original filename and the source SHA-256 are always retained regardless.

If the same run code later appears with a **different source hash**, the earlier
revision and its source are never overwritten. The history is preserved and the
UI raises a source-changed warning, because silently replacing the data behind a
published run code is how a result becomes unreproducible.

## Behaviour that is identical

Verified bit-for-bit against the vendored desktop core across 22 fixtures:
column detection, synchronisation (including the fallback where Inner borrows
Drag's sync index), gravity conversion, filtering bounds, the
minimum-standard-deviation search, the G-quality sweep, and range statistics.

The interactive graph is *behaviourally* compatible — same modes, same range
selection, same statistics — but it is drawn with uPlot on Canvas2D rather than
Matplotlib, so it is not pixel-identical, and web PNG export is not claimed to
be. **Only the formal poster renderer carries the pixel-compatibility
guarantee**, which is precisely why it exists. See `docs/poster-renderer.md`.

## Behaviour that is intentionally different

1. **No cumulative-sum fallback.** The desktop app switches to a less accurate
   approximation past 20,000,000 window elements and warns. AAT Web raises
   instead. The threshold is identical; only what happens past it differs.
2. **XLSX row limit enforced.** As above.
3. **Encoding fallback uses `TextDecoder('shift_jis')`** rather than pandas'
   `cp932` codec. Held together by the `japanese_headers_cp932` fixture.
4. **Analysis is never silently skipped.** Where the desktop app logs a warning
   and continues with a degraded result, AAT Web records a structured warning
   that travels into the analysis revision's provenance, so a reader of the
   result can see that it happened.

## Running both during transition

Nothing stops it. AAT Web reads the same CSVs and does not modify them, and it
writes nothing into `results_AAT/`. Running both on the same file and comparing
the exported workbooks is a reasonable way to build confidence — that comparison
is exactly what the golden suite automates.
