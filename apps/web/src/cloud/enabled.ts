/**
 * Is the cloud half part of this build?
 *
 * AAT Web is local-first: the analyzer needs no session, no network and no
 * Worker. The cloud features — passkey sign-in, invitations, run history, the
 * admin console — are a layer on top of that, and a deployment is allowed to
 * ship without them entirely. When it does, those features must not merely
 * fail: they must not be offered. A sign-in link that can never succeed is a
 * dead end wearing a navigation costume, and a session probe against a Worker
 * that was never deployed is a request that can only ever come back negative.
 *
 * One build-time flag is the whole switch: `VITE_AAT_CLOUD_ENABLED=false`. The
 * *only* value that disables is the literal string `'false'` — an unset
 * variable, `'true'`, or anything else keeps the cloud on, because an off flag
 * that trips on a typo like `0` or `no` would silently strip authentication
 * from a deployment that was meant to have it. Failing towards enabled is the
 * safe direction: the screens still exist, and a deployment with no Worker
 * already degrades to local-only on its own.
 *
 * This is a function rather than a module constant so tests can stub the value
 * (`vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')`) without module-level import
 * order deciding the answer before the test runs.
 */
export function cloudEnabled(): boolean {
  return import.meta.env.VITE_AAT_CLOUD_ENABLED !== 'false'
}
