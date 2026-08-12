/// <reference path="../../worker-configuration.d.ts" />

/**
 * Turning a thrown error into an HTTP response.
 *
 * The rule: **a client never sees an internal message.** Anything that is not an `ApiError` from
 * @aat/shared becomes `INTERNAL` with a freshly minted diagnostic id; the real error — message,
 * stack, cause — goes to the Worker's log alongside that same id. An operator correlates the two;
 * a client gets a code, a Japanese sentence and an opaque id, and nothing that describes the
 * server's internals.
 *
 * `ApiError.toPayload()` is structurally incapable of carrying a `cause`, so even an ApiError that
 * wraps a database exception cannot leak it. See packages/shared/src/errors.ts.
 */

import { ApiError, buildApiErrorPayload, type Locale } from '@aat/shared'
import type { Context, ErrorHandler } from 'hono'
import { newId } from '../lib/ids.ts'
import type { AppEnv } from './authorize.ts'

/** Locale for user-facing messages. Japanese is the default; `?locale=en` is honoured for an English UI. */
function requestLocale(context: Context<AppEnv>): Locale {
  const requested = new URL(context.req.url).searchParams.get('locale')
  return requested === 'en' ? 'en' : 'ja'
}

export const errorHandler: ErrorHandler<AppEnv> = (error, context) => {
  const locale = requestLocale(context)

  if (error instanceof ApiError) {
    const payload = error.toPayload(locale)
    if (error.httpStatus >= 500) {
      // A 5xx ApiError still has an internal cause worth keeping, and still must not show it.
      const diagnosticId = newId()
      console.error(
        JSON.stringify({
          diagnosticId,
          code: error.code,
          message: error.message,
          cause: String(error.cause ?? ''),
        }),
      )
      return context.json({ error: { ...payload, diagnosticId } }, error.httpStatus as 500)
    }
    return context.json({ error: payload }, error.httpStatus as 400)
  }

  const diagnosticId = newId()
  console.error(
    JSON.stringify({
      diagnosticId,
      path: new URL(context.req.url).pathname,
      method: context.req.method,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  )

  return context.json({ error: buildApiErrorPayload('INTERNAL', { locale, diagnosticId }) }, 500)
}

/** 404 for an unknown /api path, in the same envelope as every other error. */
export function notFoundHandler(context: Context<AppEnv>): Response {
  return context.json(
    { error: buildApiErrorPayload('RESOURCE_NOT_FOUND', { locale: requestLocale(context) }) },
    404,
  )
}
