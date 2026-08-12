/**
 * Operational switches that must survive a restart and be changeable without a deploy.
 *
 * Currently one: the poster renderer's circuit breaker. When an administrator opens it, no render
 * is attempted at all — the endpoint sheds load with POSTER_BUSY. That is the lever to pull when
 * the renderer is misbehaving or when spend needs to stop *now*, and waiting for a deploy to pull
 * it is exactly the wrong shape for that situation.
 */

import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.ts'
import { systemFlags } from '../db/schema.ts'

export const RENDERER_CIRCUIT_BREAKER_KEY = 'poster.renderer.circuit_breaker'

export interface CircuitBreakerState {
  /** True when the renderer is disabled and no container call may be made. */
  open: boolean
  reason: string | null
  updatedAt: string | null
}

const CLOSED: CircuitBreakerState = { open: false, reason: null, updatedAt: null }

export async function getCircuitBreaker(db: Database): Promise<CircuitBreakerState> {
  const [row] = await db
    .select()
    .from(systemFlags)
    .where(eq(systemFlags.key, RENDERER_CIRCUIT_BREAKER_KEY))
    .limit(1)
  if (!row) return CLOSED
  try {
    const parsed = JSON.parse(row.value) as { open?: unknown; reason?: unknown }
    return {
      open: parsed.open === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      updatedAt: row.updatedAt.toISOString(),
    }
  } catch {
    // A corrupt flag row must not disable the renderer by accident, nor enable it by accident.
    // Treating it as closed (renderer available) matches the default and is visible in the admin
    // endpoint, where the parse failure shows up as a missing reason.
    return CLOSED
  }
}

export async function setCircuitBreaker(
  db: Database,
  open: boolean,
  reason: string | null,
  updatedByUserId: string,
  now: Date = new Date(),
): Promise<CircuitBreakerState> {
  const value = JSON.stringify({ open, reason })
  await db
    .insert(systemFlags)
    .values({ key: RENDERER_CIRCUIT_BREAKER_KEY, value, updatedAt: now, updatedByUserId })
    .onConflictDoUpdate({
      target: systemFlags.key,
      set: { value, updatedAt: now, updatedByUserId },
    })
  return { open, reason, updatedAt: now.toISOString() }
}
