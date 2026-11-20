import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

export type Backend = 'neon' | 'sqlite'
export type SkuRecord = { sku: string; name?: string; cost?: number; tax?: number }

export type AuthUser = {
  id: number
  email: string
  name: string
  passwordSalt: string
  passwordHash: string
  resetTokenHash?: string | null
  resetExpires?: string | null
}

export const STATE = {
  snapshot: 'sync.snapshot',
  lastSync: 'sync.last',
  autoSync: 'settings.autoSync',
} as const

const neonUrl = config.neonDatabaseUrl.trim()
export const backend: Backend = neonUrl ? 'neon' : 'sqlite'

const pool = neonUrl
  ? new pg.Pool({ connectionString: neonUrl, max: 4, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 })
  : null

pool?.on('error', (error) => {
  console.error('[db] conexão Neon ociosa falhou (seguimos tentando):', error.message)
})

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(here, '../data')
mkdirSync(dataDir, { recursive: true })

const sqlite = new DatabaseSync(resolve(dataDir, 'wf-gestor.db'))

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sku_meta (
    sku TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    cost REAL,
    tax REAL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    reset_token_hash TEXT,
    reset_expires TEXT,
    created_at TEXT NOT NULL
  );
`)

{
  const cols = sqlite.prepare('PRAGMA table_info(sku_meta)').all() as { name: string }[]
  if (!cols.some((col) => col.name === 'tax')) {
    sqlite.exec('ALTER TABLE sku_meta ADD COLUMN tax REAL')
  }
}

let neonReady: Promise<void> | null = null

async function promoteSqliteToNeon() {
  if (!pool) return
  const skuRows = sqlite.prepare('SELECT sku, name, cost, tax FROM sku_meta').all() as {
    sku: string
    name: string
    cost: number | null
    tax: number | null
  }[]
  const stateRows = sqlite.prepare('SELECT key, value FROM app_state').all() as { key: string; value: string }[]
  for (const row of skuRows) {
    await pool.query(
      `INSERT INTO sku_meta (sku, name, cost, tax, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (sku) DO NOTHING`,
      [row.sku, row.name || '', row.cost ?? null, row.tax ?? null],
    )
  }
  for (const row of stateRows) {
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO NOTHING`,
      [row.key, row.value],
    )
  }
  sqlite.exec('DELETE FROM sku_meta; DELETE FROM app_state;')
}

function ensureNeon(): Promise<void> {
  if (!pool) return Promise.reject(new Error('Neon não configurado.'))
  if (!neonReady) {
    neonReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS sku_meta (
          sku text PRIMARY KEY,
          name text NOT NULL DEFAULT '',
          cost double precision,
          tax double precision,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS app_state (
          key text PRIMARY KEY,
          value text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS users (
          id serial PRIMARY KEY,
          email text NOT NULL UNIQUE,
          name text NOT NULL DEFAULT '',
          password_salt text NOT NULL,
          password_hash text NOT NULL,
          reset_token_hash text,
          reset_expires timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `)
      .then(() =>
        pool.query(`ALTER TABLE sku_meta ADD COLUMN IF NOT EXISTS tax double precision`),
      )
      .then(() => promoteSqliteToNeon())
      .catch((error) => {
        neonReady = null
        throw error
      })
  }
  return neonReady
}

export async function listSkus(): Promise<SkuRecord[]> {
  if (pool) {
    await ensureNeon()
    const { rows } = await pool.query('SELECT sku, name, cost, tax FROM sku_meta ORDER BY sku')
    return (rows as { sku: string; name: string; cost: number | null; tax: number | null }[]).map((row) => ({
      sku: row.sku,
      name: row.name || undefined,
      cost: row.cost ?? undefined,
      tax: row.tax ?? undefined,
    }))
  }
  const rows = sqlite.prepare('SELECT sku, name, cost, tax FROM sku_meta ORDER BY sku').all() as {
    sku: string
    name: string
    cost: number | null
    tax: number | null
  }[]
  return rows.map((row) => ({
    sku: row.sku,
    name: row.name || undefined,
    cost: row.cost ?? undefined,
    tax: row.tax ?? undefined,
  }))
}

export async function replaceSku(sku: string, name: string | undefined, cost: number | null, tax: number | null) {
  if (pool) {
    await ensureNeon()
    await pool.query(
      `INSERT INTO sku_meta (sku, name, cost, tax, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, cost = EXCLUDED.cost, tax = EXCLUDED.tax, updated_at = EXCLUDED.updated_at`,
      [sku, name ?? '', cost, tax],
    )
    return
  }
  sqlite
    .prepare(
      `INSERT INTO sku_meta (sku, name, cost, tax, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sku) DO UPDATE SET name = excluded.name, cost = excluded.cost, tax = excluded.tax, updated_at = excluded.updated_at`,
    )
    .run(sku, name ?? '', cost, tax, new Date().toISOString())
}

export async function importSkus(items: { sku: string; name?: string; cost?: number; tax?: number }[]) {
  if (pool) {
    await ensureNeon()
    let inserted = 0
    for (const item of items) {
      if (!item?.sku) continue
      const info = await pool.query(
        `INSERT INTO sku_meta (sku, name, cost, tax, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (sku) DO NOTHING`,
        [item.sku, item.name ?? '', item.cost ?? null, item.tax ?? null],
      )
      inserted += info.rowCount ?? 0
    }
    return inserted
  }
  const stmt = sqlite.prepare(
    `INSERT INTO sku_meta (sku, name, cost, tax, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO NOTHING`,
  )
  const now = new Date().toISOString()
  let inserted = 0
  for (const item of items) {
    if (!item?.sku) continue
    const info = stmt.run(item.sku, item.name ?? '', item.cost ?? null, item.tax ?? null, now)
    inserted += Number(info.changes ?? 0)
  }
  return inserted
}

export async function readState(key: string): Promise<string | null> {
  if (pool) {
    await ensureNeon()
    const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key])
    return (rows[0] as { value: string } | undefined)?.value ?? null
  }
  const row = sqlite.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export async function readStateJson<T>(key: string): Promise<T | null> {
  const raw = await readState(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function readBoolState(key: string, fallback: boolean): Promise<boolean> {
  const raw = await readState(key)
  if (raw === null) return fallback
  return raw === '1'
}

export async function writeState(key: string, value: string) {
  if (pool) {
    await ensureNeon()
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, value],
    )
    return
  }
  sqlite
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString())
}

export async function importState(entries: Record<string, string>) {
  if (pool) {
    await ensureNeon()
    let inserted = 0
    for (const [key, value] of Object.entries(entries)) {
      if (!key) continue
      const info = await pool.query(
        `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO NOTHING`,
        [key, value],
      )
      inserted += info.rowCount ?? 0
    }
    return inserted
  }
  const stmt = sqlite.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  )
  let inserted = 0
  for (const [key, value] of Object.entries(entries)) {
    if (!key) continue
    const info = stmt.run(key, value, new Date().toISOString())
    inserted += Number(info.changes ?? 0)
  }
  return inserted
}

/* --- Usuários (login da Fase 3) --- */

type UserRow = {
  id: number
  email: string
  name: string
  password_salt: string
  password_hash: string
  reset_token_hash?: string | null
  reset_expires?: string | null
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? '',
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    resetTokenHash: row.reset_token_hash ?? null,
    resetExpires: row.reset_expires ? new Date(row.reset_expires).toISOString() : null,
  }
}

export async function countUsers(): Promise<number> {
  if (pool) {
    await ensureNeon()
    const { rows } = await pool.query('SELECT count(*)::int AS total FROM users')
    return Number((rows[0] as { total: number }).total ?? 0)
  }
  const row = sqlite.prepare('SELECT count(*) AS total FROM users').get() as { total: number }
  return Number(row.total ?? 0)
}

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  if (pool) {
    await ensureNeon()
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email.toLowerCase()])
    return rows[0] ? toAuthUser(rows[0] as UserRow) : null
  }
  const row = sqlite.prepare('SELECT * FROM users WHERE lower(email) = ? LIMIT 1').get(email.toLowerCase()) as
    | UserRow
    | undefined
  return row ? toAuthUser(row) : null
}

export async function findUserByResetHash(hashHex: string): Promise<AuthUser | null> {
  if (pool) {
    await ensureNeon()
    const { rows } = await pool.query('SELECT * FROM users WHERE reset_token_hash = $1 LIMIT 1', [hashHex])
    return rows[0] ? toAuthUser(rows[0] as UserRow) : null
  }
  const row = sqlite.prepare('SELECT * FROM users WHERE reset_token_hash = ? LIMIT 1').get(hashHex) as
    | UserRow
    | undefined
  return row ? toAuthUser(row) : null
}

export async function findUserById(id: number): Promise<AuthUser | null> {
  if (pool) {
    await ensureNeon()
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id])
    return rows[0] ? toAuthUser(rows[0] as UserRow) : null
  }
  const row = sqlite.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').get(id) as UserRow | undefined
  return row ? toAuthUser(row) : null
}

export async function createUser(email: string, name: string, passwordSalt: string, passwordHash: string) {
  if (pool) {
    await ensureNeon()
    await pool.query(
      `INSERT INTO users (email, name, password_salt, password_hash, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (email) DO NOTHING`,
      [email.toLowerCase(), name, passwordSalt, passwordHash],
    )
    return
  }
  sqlite
    .prepare(
      `INSERT INTO users (email, name, password_salt, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    )
    .run(email.toLowerCase(), name, passwordSalt, passwordHash, new Date().toISOString())
}

export async function setUserPassword(id: number, passwordSalt: string, passwordHash: string) {
  if (pool) {
    await ensureNeon()
    await pool.query(
      'UPDATE users SET password_salt = $2, password_hash = $3, reset_token_hash = NULL, reset_expires = NULL WHERE id = $1',
      [id, passwordSalt, passwordHash],
    )
    return
  }
  sqlite
    .prepare(
      'UPDATE users SET password_salt = ?, password_hash = ?, reset_token_hash = NULL, reset_expires = NULL WHERE id = ?',
    )
    .run(passwordSalt, passwordHash, id)
}

export async function setUserReset(id: number, tokenHash: string | null, expiresAt: string | null) {
  if (pool) {
    await ensureNeon()
    await pool.query('UPDATE users SET reset_token_hash = $2, reset_expires = $3 WHERE id = $1', [
      id,
      tokenHash,
      expiresAt,
    ])
    return
  }
  sqlite.prepare('UPDATE users SET reset_token_hash = ?, reset_expires = ? WHERE id = ?').run(tokenHash, expiresAt, id)
}
