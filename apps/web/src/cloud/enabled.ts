/**
 * Whether this build may use the cloud half at all.
 *
 * `VITE_AAT_CLOUD_ENABLED` is a compile-time flag for deployments that ship the
 * frontend without the Worker: the sync/poster lanes then never issue a
 * request, which is different from an *unreachable* cloud — there is simply
 * nothing to reach, and the UI does not wait for it.
 */
export function cloudEnabled(): boolean {
  return import.meta.env.VITE_AAT_CLOUD_ENABLED !== 'false'
}
