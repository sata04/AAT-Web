/**
 * The production Pages Function, re-exported.
 *
 * Deliberately not a copy. The suite exists to test what is deployed, and a
 * second file with the same body would pass every test while drifting from the
 * one that actually runs — silently, because nothing compares them. This is the
 * real handler: its error swallowing, its request pass-through, and its binding
 * name are the ones under test.
 *
 * `apps/web/pages/functions/api/[[path]].ts` may not import anything itself
 * (scripts/resolve-pages-config.mjs enforces that, so what compiles beside the
 * production credentials can contain nothing but itself). The constraint runs
 * one way: this file importing it is fine and never reaches a deploy.
 */

export { onRequest } from '../../../../pages/functions/api/[[path]].ts'
