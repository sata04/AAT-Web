# Dependency audit: bounded gzip decoding

This entry documents the new direct use of an already locked transitive dependency.

| Package | Pin | Runtime / purpose | Licence | Runtime dependencies | Install scripts |
| --- | --- | --- | --- | --- | --- |
| fflate | 0.8.3 | Browser and Worker; synchronous streaming gzip decode with an output cap | MIT | 0 | None |

Promoted from the existing `write-excel-file` dependency graph without changing the
resolved version or integrity hash. The existing lockfile has passed the repository's
release-age and provenance policy checks. No supply-chain exceptions are added.
The offline environment lacks pnpm's registry metadata cache, so the importer was
added directly against that existing resolution; normal frozen installs must still
pass the repository's gates.

The maintained upstream library has a small tree-shakeable browser entry and a
multi-year release history. Its [pinned source](https://github.com/101arrowz/fflate/blob/v0.8.3/src/index.ts)
was checked for synchronous emission, buffer growth and checksum behavior. Native
DecompressionStream was rejected for capped decoding because workerd buffers expanded
output without backpressure. Async inflate workers add no benefit to this cap and are
not imported. A new inflater implementation would add much more code to audit.
If maintenance stops, keep the pin and replace this narrow streaming interface after
running the corruption and expansion regressions; do not remove the output guard.
