import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Autenticação do WF Gestor — scrypt para senha e sessão em cookie assinado
   (HMAC-SHA256), sem estado obrigatório no servidor. O cookie precisa de
   SameSite=None; Secure em produção porque o front (GitHub Pages) e a API
   (Render) ficam em domínios diferentes; em http local cai para SameSite=Lax,
   que os navegadores aceitam entre portas do mesmo host. */

export const SESSION_COOKIE = 'wf_session'
const SESSION_DAYS = 30

const here = dirname(fileURLToPath(import.meta.url))

/* Chave mestra: WF_SECRET no ambiente (hex de64 ou texto, que vira hash) ou
   arquivo local data/.secret gerado no primeiro boot. Trocar a chave invalida
   as sessões existentes. */
function masterKey(): Buffer {
  const fromEnv = (process.env.WF_SECRET ?? '').trim()
  if (fromEnv) {
    return /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : createHash('sha256').update(fromEnv).digest()
  }

  const file = resolve(here, '../data/.secret')
  try {
    const stored = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(stored)) return Buffer.from(stored, 'hex')
  } catch {
    /* primeira execução: gera abaixo */
  }
  const key = randomBytes(32)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  } catch {
    console.warn('[auth] Não foi possível gravar data/.secret — defina WF_SECRET no ambiente.')
  }
  return key
}

const KEY = masterKey()

/* --- Senhas (scrypt) --- */

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, 64)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}

export function verifyPassword(password: string, saltHex: string, hashHex: string): boolean {
  try {
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/* Hash dummy usado quando o e-mail não existe: mantém o tempo de resposta do
   login pareado, para não revelar quais e-mails têm conta. */
const DUMMY = hashPassword('wf-gestor-timing-equalizer')

export function burnPasswordTime(password: string): void {
  verifyPassword(password, DUMMY.salt, DUMMY.hash)
}

/* --- Sessão (cookie assinado) --- */

function b64url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(value: string): Buffer {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function signSession(userId: number): string {
  const payload = b64url(Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 })))
  const signature = b64url(createHmac('sha256', KEY).update(payload).digest())
  return `${payload}.${signature}`
}

export type Session = { uid: number; exp: number }

export function readSession(token: string | undefined): Session | null {
  if (!token || typeof token !== 'string') return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = createHmac('sha256', KEY).update(payload).digest()
  let given: Buffer
  try {
    given = unb64url(signature)
  } catch {
    return null
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const data = JSON.parse(unb64url(payload).toString('utf8')) as Session
    if (!data?.uid || !data.exp || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function isHttps(request: { protocol: string; headers: Record<string, unknown> }): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.protocol
  return proto === 'https'
}

export function sessionCookie(
  request: { protocol: string; headers: Record<string, unknown> },
  token: string,
): string {
  const secure = isHttps(request)
  const sameSite = secure ? 'SameSite=None; Secure' : 'SameSite=Lax'
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${sameSite}; Max-Age=${SESSION_DAYS * 86400}`
}

export function clearSessionCookie(request: { protocol: string; headers: Record<string, unknown> }): string {
  const secure = isHttps(request)
  const sameSite = secure ? 'SameSite=None; Secure' : 'SameSite=Lax'
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${sameSite}; Max-Age=0`
}

export function readSessionCookie(request: { headers: Record<string, unknown> }): Session | null {
  const header = request.headers.cookie
  const cookies = parseCookies(Array.isArray(header) ? header.join('; ') : (header as string | undefined))
  return readSession(cookies[SESSION_COOKIE])
}

/* --- Token de recuperação de senha --- */

export function newResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex')
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') }
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(String(token)).digest('hex')
}
