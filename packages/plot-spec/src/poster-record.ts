/**
 * The stored record for one rendered poster figure — what the API returns to the browser and
 * what a durable object / database row tracks through the render lifecycle. This is a response
 * shape, not something a client ever constructs and sends: the browser submits a
 * {@link PosterPlotSpec} (see `spec.ts`) and gets one of these back (initially `status: 'queued'`,
 * later polled or pushed until `'ready'` or `'failed'`).
 */

import { z } from 'zod'
import { POSTER_PRESET_VERSIONS } from './presets.ts'

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export const PosterFigureStatusSchema = z.enum(['queued', 'rendering', 'ready', 'failed'])
export type PosterFigureStatus = z.infer<typeof PosterFigureStatusSchema>

const PosterFigureRecordShape = z
  .object({
    /** Opaque identifier for this stored figure (not derived from `specHash` — a spec may be re-rendered). */
    posterId: z.string().min(1),
    /** {@link specHash} of the {@link PosterPlotSpec} this figure was rendered from. */
    specHash: z.string().regex(SHA256_HEX_PATTERN, 'specHash must be a lowercase SHA-256 hex digest'),
    presetVersion: z.enum(POSTER_PRESET_VERSIONS),
    /** Version string of the poster-renderer container image/build that produced (or will produce) this figure. */
    rendererVersion: z.string().min(1).max(100),
    /** Same analysis revision the source spec named; carried here for provenance without a join. */
    analysisRevisionId: z.string().min(1).max(200),
    createdAt: z.iso.datetime(),
    /** PNG byte size. 0 until `status` reaches `'ready'`. */
    objectSize: z.number().int().nonnegative(),
    /** SHA-256 hex of the rendered PNG bytes. Empty string until `status` reaches `'ready'`. */
    objectSha256: z.union([z.literal(''), z.string().regex(SHA256_HEX_PATTERN)]),
    status: PosterFigureStatusSchema,
    /** Stable machine code explaining a `'failed'` render. Present if and only if `status === 'failed'`. */
    failureCode: z.string().min(1).max(100).optional(),
  })
  .strict()

export const PosterFigureRecordSchema = PosterFigureRecordShape.superRefine((value, ctx) => {
  if (value.status === 'failed' && value.failureCode === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'failureCode is required when status is "failed"',
      path: ['failureCode'],
    })
  }
  if (value.status !== 'failed' && value.failureCode !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'failureCode must only be set when status is "failed"',
      path: ['failureCode'],
    })
  }
  if (value.status === 'ready') {
    if (value.objectSize === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'objectSize must be nonzero when status is "ready"',
        path: ['objectSize'],
      })
    }
    if (value.objectSha256 === '') {
      ctx.addIssue({
        code: 'custom',
        message: 'objectSha256 must be set when status is "ready"',
        path: ['objectSha256'],
      })
    }
  }
})

export type PosterFigureRecord = z.infer<typeof PosterFigureRecordSchema>

export function parsePosterFigureRecord(input: unknown): PosterFigureRecord {
  return PosterFigureRecordSchema.parse(input)
}

export function safeParsePosterFigureRecord(input: unknown) {
  return PosterFigureRecordSchema.safeParse(input)
}
