/**
 * Local analysis cache — the browser replacement for the desktop app's
 * pickle + HDF5 cache under `results_AAT/cache/`.
 *
 * Neither of those formats survives the move to a browser, and neither should:
 * pickle is an executable format, so deserialising one is a code-execution
 * primitive. IndexedDB stores structured-cloneable values, which covers
 * `Float64Array` directly without a serialisation format of our own.
 *
 * Cache identity keeps the *spirit* of the desktop invalidation rules — which
 * keyed on content, a settings hash and the application version — rather than
 * their implementation:
 *
 *     key = SHA-256(source bytes)
 *         + hash of the analysis-relevant configuration
 *         + analysis engine version
 *         + cache format version
 *
 * Filename and modification time are deliberately absent. A renamed file is the
 * same data; a touched file is not different data. Trusting either produces
 * both false hits and false misses.
 */

/**
 * Bumping this invalidates every stored entry.
 *
 * Raise it whenever the shape of a cached record changes. It is cheaper to
 * recompute than to write a migration for a cache.
 */
export const CACHE_FORMAT_VERSION = 1

const DATABASE_NAME = 'aat-analysis-cache'
const DATABASE_VERSION = 1
const STORE_NAME = 'analyses'
const INDEX_ACCESSED = 'lastAccessedAt'

export interface CacheKeyParts {
  /** SHA-256 of the raw source bytes, lowercase hex. */
  sourceSha256: string
  /** Hash over the configuration keys that affect numerical results. */
  configHash: string
  /** Version of the analysis engine that produced the entry. */
  engineVersion: string
}

export interface CachedAnalysis<T> {
  key: string
  sourceSha256: string
  configHash: string
  engineVersion: string
  cacheFormatVersion: number
  /** Original filename, for display only — never part of the key. */
  originalFilename: string
  createdAt: number
  lastAccessedAt: number
  /** Approximate stored size, used for eviction. */
  approximateBytes: number
  payload: T
}

/** SHA-256 of arbitrary bytes as lowercase hex, via Web Crypto. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Compose the cache key. Order is fixed so the key is stable across releases. */
export function cacheKey(parts: CacheKeyParts): string {
  return [
    `v${CACHE_FORMAT_VERSION}`,
    parts.engineVersion,
    parts.configHash,
    parts.sourceSha256,
  ].join(':')
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        // Eviction walks entries oldest-accessed first.
        store.createIndex(INDEX_ACCESSED, 'lastAccessedAt', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the analysis cache'))
  })
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Cache request failed'))
  })
}

/**
 * Read a cached analysis.
 *
 * Any failure — a corrupt entry, a schema surprise, a storage error — resolves
 * to `null` so the caller recomputes. A cache must never be able to break the
 * application it is meant to accelerate, and a *wrong* cached analysis is worse
 * than no cache at all.
 */
export async function readCache<T>(parts: CacheKeyParts): Promise<CachedAnalysis<T> | null> {
  const key = cacheKey(parts)
  let database: IDBDatabase | null = null
  try {
    database = await openDatabase()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const record = (await promisify(store.get(key))) as CachedAnalysis<T> | undefined
    if (record === undefined) return null

    // Defence in depth: the key already encodes these, but a hand-edited or
    // partially-written record must not be trusted just because its key matched.
    if (
      record.cacheFormatVersion !== CACHE_FORMAT_VERSION ||
      record.sourceSha256 !== parts.sourceSha256 ||
      record.configHash !== parts.configHash ||
      record.engineVersion !== parts.engineVersion ||
      record.payload === undefined
    ) {
      store.delete(key)
      return null
    }

    record.lastAccessedAt = Date.now()
    store.put(record)
    return record
  } catch {
    return null
  } finally {
    database?.close()
  }
}

/**
 * Store an analysis.
 *
 * Failures are swallowed: running out of quota or having storage denied is a
 * reason to skip caching, not a reason to fail an analysis that already
 * succeeded. Returns whether the write landed, so the UI can say so if it wants.
 */
export async function writeCache<T>(
  parts: CacheKeyParts,
  originalFilename: string,
  payload: T,
  approximateBytes: number,
): Promise<boolean> {
  let database: IDBDatabase | null = null
  try {
    database = await openDatabase()
    const now = Date.now()
    const record: CachedAnalysis<T> = {
      key: cacheKey(parts),
      sourceSha256: parts.sourceSha256,
      configHash: parts.configHash,
      engineVersion: parts.engineVersion,
      cacheFormatVersion: CACHE_FORMAT_VERSION,
      originalFilename,
      createdAt: now,
      lastAccessedAt: now,
      approximateBytes,
      payload,
    }
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    await promisify(transaction.objectStore(STORE_NAME).put(record))
    return true
  } catch {
    return false
  } finally {
    database?.close()
  }
}

/**
 * Evict least-recently-accessed entries until the cache fits the budget.
 *
 * Browsers evict origin storage on their own schedule and without warning, so
 * this is about staying a good citizen rather than about correctness — every
 * entry is reproducible from the source file.
 */
export async function evictToBudget(budgetBytes: number): Promise<number> {
  let database: IDBDatabase | null = null
  try {
    database = await openDatabase()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const records = (await promisify(store.getAll())) as Array<CachedAnalysis<unknown>>

    let total = records.reduce((sum, record) => sum + (record.approximateBytes || 0), 0)
    if (total <= budgetBytes) return 0

    records.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
    let evicted = 0
    for (const record of records) {
      if (total <= budgetBytes) break
      store.delete(record.key)
      total -= record.approximateBytes || 0
      evicted++
    }
    return evicted
  } catch {
    return 0
  } finally {
    database?.close()
  }
}

/** Remove every entry — the "clear local cache" action in settings. */
export async function clearCache(): Promise<void> {
  let database: IDBDatabase | null = null
  try {
    database = await openDatabase()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    await promisify(transaction.objectStore(STORE_NAME).clear())
  } catch {
    // Nothing to report: the cache holds no irreplaceable data.
  } finally {
    database?.close()
  }
}
