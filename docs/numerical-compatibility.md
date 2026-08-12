# Numerical compatibility

AAT Web replaces a Python/NumPy/pandas desktop application. The scientific
results it produces must be the *same* results, not merely similar ones: a
figure in a paper produced by AAT Web has to be defensible against one produced
by the desktop app from the same CSV.

This document records how that is established, what the guarantee actually is,
and where the two implementations deliberately differ.

## The oracle

`reference/python/core/` is a **verbatim, unmodified copy** of the desktop
application's `core/` package. The commit it was taken from is recorded in
`reference/python/REFERENCE_COMMIT.txt` and echoed into
`tests/golden/index.json` as `referenceCommit`.

`reference/python/generate_golden.py` runs that vendored core over every fixture
in `reference/python/fixtures.py` and records what it produced. Nothing in the
generator reimplements the analysis — it calls `detect_columns`,
`load_and_process_data`, `filter_data`, `calculate_statistics` and
`calculate_range_statistics` directly, and reproduces only the G-quality sweep
loop from `gui/workers.py` (which is otherwise entangled with Qt).

Regenerate with:

```bash
python reference/python/generate_golden.py           # rewrite fixtures + goldens
python reference/python/generate_golden.py --check   # CI: fail if stale
```

The `--check` form runs in CI. If the vendored reference or a fixture changes
without the goldens being regenerated, the build fails rather than silently
comparing against stale expectations.

## The guarantee: bit equality, not tolerance

The TypeScript engine reproduces the Python reference **bit-for-bit** for every
value the golden files record. This is stronger than the "documented tolerance"
a port like this normally settles for, and it was a deliberate choice, because
tolerance is not actually sufficient here.

The analysis picks the window with the smallest standard deviation across
thousands of overlapping candidates. Neighbouring windows routinely differ in
standard deviation by less than a tolerance one would consider generous. A port
that is merely *close* will, on some real inputs, select a **different window**
— and then report a different mean gravity level, a different start time, and a
different G-quality curve. The error is not small-and-bounded; it is discrete
and unbounded. Bit equality removes the failure mode instead of bounding it.

### What made bit equality achievable

`core/statistics.py` computes window statistics with NumPy's `ndarray.std()`
and `ndarray.mean()`. Those are **not** naive accumulation loops. NumPy sums
with a pairwise algorithm (`pairwise_sum_@TYPE@` in
`numpy/_core/src/umath/loops_utils.h.src`):

| window length | algorithm |
| --- | --- |
| `n < 8` | straight left-to-right accumulation |
| `n <= 128` | eight partial accumulators, combined as `((r0+r1)+(r2+r3)) + ((r4+r5)+(r6+r7))`, remainder added left-to-right |
| `n > 128` | split at `n/2` **rounded down to a multiple of 8**, recurse on both halves |

`packages/analysis-core/src/numeric.ts` implements exactly this. The difference
from naive summation is not academic — measured on a genuinely constant window
of 400 samples:

```
NumPy std                       1.734723475976807e-18
pairwise reimplementation       1.734723475976807e-18   (identical)
naive accumulation              2.6020852139652106e-17  (15x larger)
```

Validated further against the real strided sliding-window data from the
`normal_two_sensor_utf8` fixture: **zero mismatches** in window mean, absolute
mean and standard deviation across sampled windows spanning the whole array.

Two other rounding details matter and are ported explicitly:

- **Window width.** `max(1, round(window_size * sampling_rate))` uses Python's
  `round`, which is banker's rounding (half to even). JavaScript's `Math.round`
  is half-up and picks a different window width at exact halves.
  `roundHalfToEven` in `statistics.ts` handles this.
- **Tie resolution.** `np.nanargmin` returns the *first* minimum. The port uses
  a strict `<` comparison so equal minima resolve to the earliest window, which
  the desktop source documents as intentional. The `tie_equal_minimum` fixture
  constructs two bit-identical candidate windows (at indices 100 and 900) and
  asserts index 100 wins.

## Fixtures

22 fixtures, all generated deterministically from seeded NumPy so the bytes on
disk are reproducible. CSVs live in `tests/fixtures/csv/` and are checked in, so
the TypeScript suite parses exactly the bytes the Python oracle parsed.

| fixture | what it pins down |
| --- | --- |
| `normal_two_sensor_utf8` | nominal two-sensor run |
| `japanese_headers_utf8` | Japanese column names, UTF-8 |
| `japanese_headers_cp932` | Windows-31J decoding path |
| `inner_only`, `drag_only` | single-sensor configurations |
| `missing_sync_point` | no sample below threshold — fallback to sample 0 |
| `sync_at_nonzero_index` | sync found late, and at different indices per sensor |
| `nan_missing_samples` | NaN gaps exclude windows from the search |
| `inf_values` | ±Inf treated as missing, not as data |
| `non_numeric_mixed` | text cells coerced to missing |
| `non_monotonic_time` | time axis stepping backwards |
| `duplicate_time` | repeated timestamps |
| `constant_window` | exactly-constant stretch |
| `large_dc_offset` | 1e6 mean with 1e-6 variance — cancellation |
| `extreme_spike_positive/negative` | 1000 G spike inside the analysis range |
| `tie_equal_minimum` | two identical minima, earliest must win |
| `short_data` | shorter than one window — statistics are `None` |
| `comparison_a`, `comparison_b` | comparison-mode datasets |
| `realistic_large` | 20 s at 1 kHz |
| `crlf_quoted_headers` | CRLF line endings, quoted headers containing commas |

Each golden records: detected column candidates, sync indices and which fallback
fired, adjusted-time and gravity series, filtered series and their index bounds,
the minimum-standard-deviation statistics, the full G-quality sweep, and range
statistics for declared selections.

### Why the arrays are binary

Float64 series are stored as content-addressed little-endian binaries under
`tests/golden/arrays/`, referenced by SHA-256. JSON would either lose bits or
bloat the repository, and it cannot represent NaN or ±Infinity at all. Scalars
*do* travel through JSON: Python's `repr` emits the shortest round-tripping
representation and JavaScript's parser recovers the identical double, so that
path is exact. Non-finite scalars use the tagged strings `"NaN"`, `"Infinity"`,
`"-Infinity"`.

Comparison uses IEEE-754 bit patterns rather than `===`, because `===` treats
NaN as unequal to itself and `+0` as equal to `-0` — neither is what a numerical
contract wants.

## Semantics carried over deliberately

These are behaviours of the desktop implementation that the port reproduces
because they are load-bearing, not incidental:

- Invalid numeric cells become **missing values**, never strings leaking into
  arithmetic downstream.
- **±Infinity is missing**, not data. Admitting it poisons a whole channel.
- **Incomplete windows cannot win** the minimum-standard-deviation search. A
  standard deviation is only defined over a fully observed window; allowing
  partial ones lets a window holding two valid samples win with std ≈ 0 while
  reporting a mean computed over a different sample count.
- **Two-pass standard deviation.** Mean first, then the mean of squared
  deviations. This is what survives a large DC offset, and `large_dc_offset`
  exists to keep it that way.
- **Rows with invalid timestamps are masked, not dropped.** Dropping them would
  change the spacing between adjacent samples, and therefore change what a
  window measured in *seconds* actually covers.
- **Sensors filter and synchronise independently.** Inner and Drag Shield each
  carry their own time axis and their own trim bounds.
- **The sync fallback chain is contract.** First index where
  `|acceleration| < acceleration_threshold`; if Inner has no such sample but
  Drag does, Inner *borrows Drag's index*; otherwise sample 0.
- **Range statistics exclude non-finite samples and report how many** were
  excluded, rather than returning NaN for everything and leaving the user with
  unexplained blanks.
- **Invalid analysis parameters fail loudly.** Zero, negative or non-finite
  `window_size` / `sampling_rate` raise rather than collapsing to a one-sample
  window that would report a flawless std of 0.

## Deliberate differences from the desktop application

Each of these is a considered divergence, not an oversight.

### 1. The cumulative-sum fallback is not ported

`_rolling_window_stats` falls back to a cumulative-sum approximation when
`num_windows * window_samples` exceeds 20,000,000 elements, and logs a warning
that accuracy may degrade. The web engine raises `AnalysisSizeError` instead.

Rationale: the fallback is a degraded path the desktop app itself warns about; a
browser cannot usefully allocate that shape anyway; and silently switching to a
less accurate algorithm is exactly the kind of hidden transformation the
analysis contract forbids. The threshold constant is preserved
(`EXACT_ELEMENT_BUDGET`) so the boundary is identical — only the behaviour past
it differs, and it differs by failing rather than by quietly approximating.

### 2. The XLSX row limit is enforced (legacy bug corrected)

`core/export.py` guards the unified time axis at `MAX_UNIFIED_SAMPLES =
20,000,000`. That is an application memory guard and has nothing to do with what
a worksheet can hold: a modern XLSX worksheet is limited to **1,048,576 rows**,
header included. The desktop app can therefore build a DataFrame it cannot
write.

AAT Web keeps an independent memory guard *and* enforces the real worksheet
limit before generating a workbook. When the data cannot be represented it
raises `EXPORT_TOO_LARGE` with a clear message and offers CSV as the lossless
alternative. It never silently truncates rows and never silently drops a sensor.
This is the one place where the reference implementation is treated as carrying
a bug rather than a specification.

### 3. Encoding fallback uses the WHATWG decoder

The desktop app retries with pandas' `cp932` codec. The browser has
`TextDecoder('shift_jis')`, which implements the WHATWG Shift_JIS index and
accepts the `windows-31j` / `ms932` labels. These agree on the overwhelming
majority of real content but are not defined by the same table, so the
`japanese_headers_cp932` fixture exists to hold the paths together on data that
actually matters. Note that CP932 has no U+00B2 SUPERSCRIPT TWO, so the CP932
fixture spells its units out — a constraint any real Windows-31J instrument file
shares.

## Reviewing a mismatch

If a golden assertion fails, the correct response is **never** to add a
tolerance or relax the comparison. Bit equality is achievable and currently
holds; a mismatch means the port diverged. Work through, in order:

1. Which fixture, which field, which array index, and both values in full
   precision — the test failures print this.
2. Is it a summation-order difference? Compare against a direct
   `pairwiseSum` of the same window.
3. Is it a window-width difference? Check `roundHalfToEven` against Python's
   `round` for that exact product.
4. Is it a boundary difference? Inclusive vs exclusive end indices, `>=` vs `>`
   in the start/end index searches.
5. Is it an ordering difference? `np.argsort(kind='stable')` in the export
   resampler, or tie handling in `nanArgMin`.
6. Only if the difference is genuinely inherent to the platform (it has not been
   so far) may it be documented here as a new deliberate difference, with a
   regression test pinning the new behaviour.
