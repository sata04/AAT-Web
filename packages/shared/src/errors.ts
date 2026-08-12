/**
 * Error taxonomy shared by the browser app and the Cloudflare Worker.
 *
 * Every error the API can return is one of a fixed set of stable machine `code`s. Codes — not
 * HTTP status or message text — are what client code should branch on, so they stay stable even
 * if wording or status codes are tuned later.
 *
 * The desktop app's user-facing errors are Japanese (see `core/exceptions.py`), so Japanese is
 * the default locale here too; English is carried alongside for a future English UI rather than
 * bolted on afterward.
 */

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_USED',
  'RECOVERY_INVALID',
  'RESOURCE_NOT_FOUND',
  'QUOTA_EXCEEDED',
  'SOURCE_TOO_LARGE',
  'SNAPSHOT_INVALID',
  'POSTER_BUSY',
  'POSTER_RENDER_FAILED',
  'EXPORT_TOO_LARGE',
  'INVALID_CSV',
  'INVALID_ANALYSIS_CONFIG',
  'RATE_LIMITED',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type Locale = 'ja' | 'en'

interface ErrorSpec {
  httpStatus: number
  message: Record<Locale, string>
}

const ERROR_SPECS: Record<ErrorCode, ErrorSpec> = {
  AUTH_REQUIRED: {
    httpStatus: 401,
    message: { ja: 'ログインが必要です。', en: 'Authentication is required.' },
  },
  FORBIDDEN: {
    httpStatus: 403,
    message: {
      ja: 'この操作を行う権限がありません。',
      en: 'You do not have permission to perform this action.',
    },
  },
  INVITE_INVALID: {
    httpStatus: 400,
    message: { ja: '招待リンクが無効です。', en: 'The invitation link is invalid.' },
  },
  INVITE_EXPIRED: {
    httpStatus: 410,
    message: { ja: '招待リンクの有効期限が切れています。', en: 'The invitation link has expired.' },
  },
  INVITE_USED: {
    httpStatus: 409,
    message: {
      ja: 'この招待リンクはすでに使用されています。',
      en: 'This invitation link has already been used.',
    },
  },
  RECOVERY_INVALID: {
    httpStatus: 400,
    message: { ja: 'リカバリーコードが無効です。', en: 'The recovery code is invalid.' },
  },
  RESOURCE_NOT_FOUND: {
    httpStatus: 404,
    message: { ja: '指定されたリソースが見つかりません。', en: 'The requested resource was not found.' },
  },
  QUOTA_EXCEEDED: {
    httpStatus: 429,
    message: { ja: '利用上限に達しました。', en: 'The usage quota has been exceeded.' },
  },
  SOURCE_TOO_LARGE: {
    httpStatus: 413,
    message: {
      ja: 'CSVファイルのサイズが上限を超えています。',
      en: 'The source CSV file exceeds the size limit.',
    },
  },
  SNAPSHOT_INVALID: {
    httpStatus: 422,
    message: {
      ja: '解析スナップショットの形式が正しくありません。',
      en: 'The analysis snapshot is malformed.',
    },
  },
  POSTER_BUSY: {
    httpStatus: 429,
    message: {
      ja: 'ポスター生成が混み合っています。しばらくしてから再度お試しください。',
      en: 'Poster generation is busy right now; please try again shortly.',
    },
  },
  POSTER_RENDER_FAILED: {
    httpStatus: 500,
    message: { ja: 'ポスターの生成に失敗しました。', en: 'Poster rendering failed.' },
  },
  EXPORT_TOO_LARGE: {
    httpStatus: 413,
    message: {
      ja: 'エクスポートするデータが大きすぎます。',
      en: 'The export is too large to generate.',
    },
  },
  INVALID_CSV: {
    httpStatus: 422,
    message: { ja: 'CSVファイルを読み込めませんでした。', en: 'The CSV file could not be parsed.' },
  },
  INVALID_ANALYSIS_CONFIG: {
    httpStatus: 400,
    message: { ja: '解析設定が無効です。', en: 'The analysis configuration is invalid.' },
  },
  RATE_LIMITED: {
    httpStatus: 429,
    message: {
      ja: 'リクエストが多すぎます。しばらくしてから再度お試しください。',
      en: 'Too many requests; please try again shortly.',
    },
  },
  INTERNAL: {
    httpStatus: 500,
    message: { ja: 'サーバー内部でエラーが発生しました。', en: 'An internal server error occurred.' },
  },
}

/** Structured, JSON-serialisable detail payload attached to an error. Never put secrets here. */
export type ApiErrorDetails = Record<string, unknown>

/** The wire shape sent to the client. Deliberately has no field capable of carrying `cause`. */
export interface ApiErrorPayload {
  code: ErrorCode
  httpStatus: number
  /** Message in the requested locale (Japanese by default). */
  message: string
  /** Both locales, for clients that want to switch language without a round trip. */
  messages: Record<Locale, string>
  details?: ApiErrorDetails
  /** Opaque id an operator can use to find the corresponding server log entry. */
  diagnosticId?: string
}

export interface BuildApiErrorOptions {
  locale?: Locale
  details?: ApiErrorDetails
  diagnosticId?: string
}

/** Build a client-safe error payload for `code`. Pure function — does not touch any error object. */
export function buildApiErrorPayload(code: ErrorCode, options: BuildApiErrorOptions = {}): ApiErrorPayload {
  const spec = ERROR_SPECS[code]
  const locale = options.locale ?? 'ja'
  const payload: ApiErrorPayload = {
    code,
    httpStatus: spec.httpStatus,
    message: spec.message[locale],
    messages: { ...spec.message },
  }
  if (options.details !== undefined) payload.details = options.details
  if (options.diagnosticId !== undefined) payload.diagnosticId = options.diagnosticId
  return payload
}

/**
 * Throwable API error carrying a stable `code` plus everything needed to answer the HTTP request.
 *
 * Server code may attach an internal `cause` (a wrapped exception, a stack trace, a database
 * error) via the standard `Error` cause option. That cause is kept only on the `ApiError`
 * instance itself — `toPayload()` never reads it, so it is structurally impossible for a cause to
 * leak into a response body by way of this class. Logging code that wants the cause should read
 * `error.cause` directly from the caught `ApiError`, never from a payload.
 */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly details?: ApiErrorDetails
  readonly diagnosticId?: string

  constructor(code: ErrorCode, options: BuildApiErrorOptions & { cause?: unknown } = {}) {
    const spec = ERROR_SPECS[code]
    const locale = options.locale ?? 'ja'
    super(spec.message[locale], options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ApiError'
    this.code = code
    this.httpStatus = spec.httpStatus
    if (options.details !== undefined) this.details = options.details
    if (options.diagnosticId !== undefined) this.diagnosticId = options.diagnosticId
  }

  /** Build the JSON-safe payload to send to the client. `cause` is NEVER included. */
  toPayload(locale: Locale = 'ja'): ApiErrorPayload {
    const options: BuildApiErrorOptions = { locale }
    if (this.details !== undefined) options.details = this.details
    if (this.diagnosticId !== undefined) options.diagnosticId = this.diagnosticId
    return buildApiErrorPayload(this.code, options)
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}
