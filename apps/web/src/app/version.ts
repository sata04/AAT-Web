/**
 * Version constants.
 *
 * These are not decoration: `ANALYSIS_ENGINE_VERSION` is part of the local cache
 * key, so bumping it invalidates every stored analysis, and it is recorded in
 * cloud snapshots so a published figure can always be traced to the code that
 * produced it. Raise it whenever `@aat/analysis-core` changes a number.
 *
 * They are hard-coded rather than read from `package.json` at build time because
 * `apps/web/package.json` carries no version field, and inventing a build-time
 * define for a value that must be reviewed by a human on every change would make
 * it easier to forget than to remember.
 */

/** Version of `@aat/analysis-core` (its `package.json` version). */
export const ANALYSIS_ENGINE_VERSION = '1.0.0'

/** Version of the web application shell. */
export const APP_VERSION = '1.0.0'

/** The desktop release this rewrite tracks; shown in the about/provenance line. */
export const DESKTOP_BASELINE_VERSION = '11.1.0'
