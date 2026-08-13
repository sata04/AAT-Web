/**
 * Tag rules, restated from the Worker so a control can refuse before the round trip.
 *
 * The three bounds are `runs.ts`'s `tagSchema` and `z.array(tagSchema).max(32)`. They are copied
 * rather than imported because the Worker's schema is a Zod object built for validation, not a
 * vocabulary a form can render — but the *numbers* must not drift, so they are named here with the
 * route quoted beside them.
 *
 * The control-character check is by code point rather than by a regex character class, which is
 * what `worker/routes/runs.ts` does and for the reason it states: a class spanning the control
 * range has to contain control characters, which is exactly what a linter should flag.
 *
 * The reason tags are validated at all — rather than left to the server — is that they are shown
 * verbatim on a gallery of other people's measurements. They are rendered as text nodes, never as
 * markup; refusing control characters is the second layer, not the first.
 */

/** `runs.ts`: `z.array(tagSchema).max(32)`. */
export const MAX_TAGS = 32

/** `runs.ts`: `z.string().min(1).max(64)`. */
export const MAX_TAG_LENGTH = 64

/**
 * Why a tag was refused, or `null` when it is acceptable.
 *
 * Japanese, because the string is shown to the user verbatim. Each answer names the specific rule
 * rather than saying "invalid": "そのタグはすでに付いています" and "タグは 64 文字までです" lead to
 * different next actions, and a single generic message leads to guessing.
 */
export function describeTagProblem(tag: string, existing: readonly string[]): string | null {
  const trimmed = tag.trim()
  if (trimmed === '') return 'タグを入力してください。'
  if (trimmed.length > MAX_TAG_LENGTH) return `タグは ${MAX_TAG_LENGTH} 文字までです。`
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return 'タグに制御文字は使えません。'
  }
  if (existing.includes(trimmed)) return 'そのタグはすでに付いています。'
  if (existing.length >= MAX_TAGS) return `タグは ${MAX_TAGS} 個までです。`
  return null
}
