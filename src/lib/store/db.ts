// Versioned IndexedDB access (P11.1), no wrapper library (four stores, six operations). Resolves to typed outcome, never throws (P11.9).

export const DB_NAME = 'frostsim'
export const DB_VERSION = 1

export type StoreName = 'characters' | 'reports' | 'blobs' | 'setups'

export type StorageFailure =
  | { kind: 'unavailable'; message: string }
  | { kind: 'quota'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'corrupt'; message: string }
  | { kind: 'invalid-record'; message: string }
  | { kind: 'error'; message: string }

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: StorageFailure }

export function classifyStorageError(err: unknown): StorageFailure {
  const name = (err as DOMException | undefined)?.name ?? ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return { kind: 'quota', message }
  if (name === 'SecurityError' || name === 'InvalidStateError') {
    return { kind: 'unavailable', message }
  }
  if (name === 'VersionError' || name === 'AbortError') return { kind: 'blocked', message }
  // Invalid keys and uncloneable input are write bugs, not damaged data.
  if (name === 'DataError' || name === 'DataCloneError') return { kind: 'invalid-record', message }
  return { kind: 'error', message }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new DOMException('IndexedDB is unavailable', 'SecurityError'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => migrate(req.result, event.oldVersion)
    req.onsuccess = () => {
      // Newer tab upgrading schema closes connection; drop cache and reopen.
      req.result.onversionchange = () => { req.result.close(); dbPromise = null }
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new DOMException('another tab holds an older database', 'AbortError'))
  }).catch((err) => { dbPromise = null; throw err })
  return dbPromise
}

/** Schema history; each step in versionchange transaction, failure aborts upgrade and preserves old data (P11.1). */
function migrate(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const characters = db.createObjectStore('characters', { keyPath: 'id' })
    characters.createIndex('updatedAt', 'updatedAt')

    const reports = db.createObjectStore('reports', { keyPath: 'id' })
    reports.createIndex('createdAt', 'createdAt')
    reports.createIndex('tool', 'tool')
    reports.createIndex('characterId', 'characterId')

    // Raw engine JSON split from summary so history list never loads it.
    db.createObjectStore('blobs', { keyPath: 'id' })

    const setups = db.createObjectStore('setups', { keyPath: 'id' })
    setups.createIndex('updatedAt', 'updatedAt')
  }
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<Outcome<T>> {
  return openDb().then(
    (db) =>
      new Promise<Outcome<T>>((resolve) => {
        let req: IDBRequest<T>
        try {
          const tx = db.transaction(store, mode)
          req = body(tx.objectStore(store))
        } catch (err) {
          resolve({ ok: false, failure: classifyStorageError(err) })
          return
        }
        req.onsuccess = () => resolve({ ok: true, value: req.result })
        req.onerror = () => {
          req.transaction?.abort()
          resolve({ ok: false, failure: classifyStorageError(req.error) })
        }
      }),
    (err) => ({ ok: false, failure: classifyStorageError(err) }),
  )
}

export function get<T>(store: StoreName, id: string): Promise<Outcome<T | undefined>> {
  return run<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>)
}

export function put<T>(store: StoreName, value: T): Promise<Outcome<IDBValidKey>> {
  return run<IDBValidKey>(store, 'readwrite', (s) => s.put(value))
}

export function del(store: StoreName, id: string): Promise<Outcome<undefined>> {
  return run<undefined>(store, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>)
}

export function all<T>(store: StoreName, index?: string): Promise<Outcome<T[]>> {
  return run<T[]>(store, 'readonly', (s) =>
    (index ? s.index(index) : s).getAll() as IDBRequest<T[]>)
}

export function clear(store: StoreName): Promise<Outcome<undefined>> {
  return run<undefined>(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>)
}

export interface StorageUsage {
  usage?: number
  quota?: number
  persisted: boolean
}

export async function storageUsage(): Promise<StorageUsage> {
  const persisted = (await navigator.storage?.persisted?.()) ?? false
  const est = await navigator.storage?.estimate?.().catch(() => undefined)
  return { usage: est?.usage, quota: est?.quota, persisted }
}

/**
 * Ask the browser to exempt this origin from eviction. It can refuse silently,
 * and even a granted request is not a durability guarantee — the caller must
 * keep telling the user that downloads are the real backup (P11.10).
 */
/** Ask browser to exempt this origin from eviction. Not a durability guarantee; downloads are real backup (P11.10). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
