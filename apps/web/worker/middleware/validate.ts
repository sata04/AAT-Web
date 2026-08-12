/**
 * Request validation.
 *
 * `@hono/zod-validator` reports failures in its own shape; this wrapper converts them into the
 * @aat/shared taxonomy so that a client parses one error envelope for every endpoint, and so that
 * Zod's issue list — which quotes the offending input back — never reaches the response.
 *
 * A note on the code chosen: the taxonomy has no general-purpose "malformed request" code. The
 * nearest 400 is `INVALID_ANALYSIS_CONFIG`, which is exactly right for a plot spec or an analysis
 * configuration and a stretch for, say, a mistyped memo field. `details.fields` names the offending
 * paths so the client can still be precise. Widening the taxonomy would mean editing
 * packages/shared, which this work does not own.
 */

import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import { ApiError } from '@aat/shared'
import type { ZodType } from 'zod'

export function validate<Target extends keyof ValidationTargets, Schema extends ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join('.')).filter((path) => path !== '')
      throw new ApiError('INVALID_ANALYSIS_CONFIG', {
        details: { target, fields: fields.slice(0, 20) },
      })
    }
    return undefined
  })
}
