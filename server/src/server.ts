import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, isConfigured, missingKeys } from './config.js'
import {
  burnPasswordTime,
  clearSessionCookie,
  hashPassword,
  hashResetToken,
  newResetToken,
  readSessionCookie,
  sessionCookie,
  signSession,
  verifyPassword,
} from './auth.js'
import {
  STATE,
  backend,
  countUsers,
  createUser,
  findUserByEmail,
  findUserById,
  findUserByResetHash,
  importSkus,
  importState,
  listSkus,
  readBoolState,
  readState,
  readStateJson,
  replaceSku,
  setUserPassword,
  setUserReset,
  writeState,
} from './db.js'
import { sendRecoveryEmail } from './email.js'
import { fetchLive, fetchOrdersDetailed, handlers, resourceKeys } from './resources.js'
import { SpApiError } from './spapi.js'
import { cancelSync, startSync, statusSync, stepSync } from './sync.js'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, '../../dist')
const hasFront = existsSync(resolve(distDir, 'index.html'))

const app = Fastify({ logger: true })

/* POST sem corpo (ex.: /auth/logout) com Content-Type application/json
   quebrava com FST_ERR_CTP_EMPTY_JSON_BODY antes de chegar na rota — o
   cookie de sessao nunca era limpo. Body vazio vira {}. */
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : ''
    if (!raw) return done(null, {})
    try {
      done(null, JSON.parse(raw))
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('JSON inválido')
      done(Object.assign(error, { statusCode: 400 }), undefined)
    }
  },
)

app.addHook('onRequest', async (request, reply) => {
  if (request.headers['access-control-request-private-network']) {
    reply.header('access-control-allow-private-network', 'true')
  }
})

// methods explicito: o default de @fastify/cors e 'GET,HEAD,POST' (sem PUT),
// o que faz o navegador barrar o preflight dos PUT /db/* e o cliente reportar
// "proxy indisponivel".
// credentials: o front (GitHub Pages) manda o cookie de sessão, e CORS com
// credenciais proibe ACAO "*": por isso config.corsOrigin lista as origens.
// As origens do app Capacitor (APK Android) entram sempre, mesmo quando
// CORS_ORIGIN vem definida no ambiente — sem isso o app nativo e barrado.
const NATIVE_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost']
const allowedOrigins =
  config.corsOrigin === '*'
    ? true
    : [
        ...new Set([
          ...config.corsOrigin.split(',').map((value) => value.trim()).filter(Boolean),
          ...NATIVE_ORIGINS,
        ]),
      ]
await app.register(cors, {
  origin: allowedOrigins,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
})

/* Todo /amazon/* e /db/* exige sessão (cookie assinado). /health e /auth/*
   ficam públicos: o keep-alive usa /health e o próprio login usa /auth. */
app.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') return // preflight do CORS
  const path = request.url.split('?')[0]
  if (!path.startsWith('/amazon') && !path.startsWith('/db')) return
  if (!readSessionCookie(request)) {
    return reply.code(401).send({ ok: false, error: 'Faça login para acessar o proxy.', detail: 'Sessão ausente ou expirada.' })
  }
})

if (hasFront) {
  await app.register(fastifyStatic, { root: distDir, index: ['index.html'] })
}

app.get('/health', async () => ({ ok: true, service: 'wf-gestor-proxy' }))

app.get('/db/state', async () => ({
  ok: true,
  backend,
  skus: await listSkus(),
  snapshot: await readStateJson<Record<string, number>>(STATE.snapshot),
  lastSync: await readState(STATE.lastSync),
  autoSync: await readBoolState(STATE.autoSync, true),
}))

app.put<{ Params: { sku: string }; Body: { name?: string | null; cost?: number | null; tax?: number | null } }>(
  '/db/skus/:sku',
  async (request, reply) => {
    const sku = decodeURIComponent(request.params.sku ?? '').trim()
    if (!sku) return reply.code(400).send({ ok: false, error: 'SKU vazio.' })
    const body = request.body ?? {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const cost = typeof body.cost === 'number' && Number.isFinite(body.cost) ? body.cost : null
    const tax = typeof body.tax === 'number' && Number.isFinite(body.tax) ? body.tax : null
    try {
      await replaceSku(sku, name, cost, tax)
    } catch (error) {
      request.log.error(error)
      return reply
        .code(502)
        .send({ ok: false, error: 'Banco do proxy indisponível no momento.', detail: 'Neon/SQLite não respondeu; tente de novo em instantes.' })
    }
    return { ok: true, sku }
  },
)

app.put<{
  Body: { snapshot?: Record<string, number> | null; lastSync?: string | null; autoSync?: boolean }
}>('/db/state', async (request, reply) => {
  const body = request.body ?? {}
  try {
    if (body.snapshot !== undefined) {
      await writeState(STATE.snapshot, JSON.stringify(body.snapshot ?? null))
    }
    if (body.lastSync !== undefined) {
      await writeState(STATE.lastSync, body.lastSync ?? '')
    }
    if (body.autoSync !== undefined) {
      await writeState(STATE.autoSync, body.autoSync ? '1' : '0')
    }
  } catch (error) {
    request.log.error(error)
    return reply
      .code(502)
      .send({ ok: false, error: 'Banco do proxy indisponível no momento.', detail: 'Neon/SQLite não respondeu; tente de novo em instantes.' })
  }
  return { ok: true }
})

app.post<{ Body: { skus?: { sku: string; name?: string; cost?: number; tax?: number }[]; state?: Record<string, string> } }>(
  '/db/import',
  async (request) => {
    const body = request.body ?? {}
    const skus = Array.isArray(body.skus) ? body.skus : []
    const state = body.state && typeof body.state === 'object' && !Array.isArray(body.state) ? body.state : {}
    return { ok: true, insertedSkus: await importSkus(skus), insertedState: await importState(state) }
  },
)

app.get('/amazon/health', async () => {
  const configured = isConfigured()
  return {
    ok: configured,
    configured,
    marketplaceId: config.marketplaceId,
    region: config.region,
    detail: configured
      ? `proxy SP-API pronto para a loja ${config.marketplaceId}`
      : `credenciais ausentes: ${missingKeys().join(', ')}`,
  }
})

app.get<{ Querystring: { since?: string } }>('/amazon/orders-detailed', async (request, reply) => {
  if (!isConfigured()) {
    return reply.code(503).send({
      ok: false,
      error: 'Proxy sem credenciais da Amazon.',
      detail: `Preencha no .env: ${missingKeys().join(', ')}`,
    })
  }

  const querySince = request.query.since
  const since =
    querySince && /^\d{4}-\d{2}-\d{2}$/.test(querySince)
      ? querySince
      : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

  try {
    const result = await fetchOrdersDetailed(since)
    return { ok: true, resource: 'orders-detailed', since, ...result }
  } catch (error) {
    if (error instanceof SpApiError) {
      return reply.code(502).send({ ok: false, error: error.message, detail: error.detail })
    }
    throw error
  }
})

app.get<{ Querystring: { since?: string } }>('/amazon/live', async (request, reply) => {
  if (!isConfigured()) {
    return reply.code(503).send({
      ok: false,
      error: 'Proxy sem credenciais da Amazon.',
      detail: `Preencha no .env: ${missingKeys().join(', ')}`,
    })
  }

  const querySince = request.query.since
  const bucket = Math.floor((Date.now() - 48 * 3600000) / 30000) * 30000
  const since =
    querySince && !Number.isNaN(Date.parse(querySince))
      ? querySince
      : new Date(bucket).toISOString()

  try {
    const result = await fetchLive(since)
    return { ok: true, resource: 'live', since, ...result }
  } catch (error) {
    if (error instanceof SpApiError) {
      return reply.code(502).send({ ok: false, error: error.message, detail: error.detail })
    }
    throw error
  }
})

/* --- Sincronização em blocos: itens de todos os pedidos sem estourar a cota --- */

function sendSyncError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof SpApiError) {
    return reply.code(502).send({ ok: false, error: error.message, detail: error.detail })
  }
  const status = (error as { statusCode?: number }).statusCode
  if (typeof status === 'number') {
    return reply.code(status).send({ ok: false, error: (error as Error).message })
  }
  request.log.error(error)
  return reply
    .code(500)
    .send({ ok: false, error: 'Falha inesperada na importação.', detail: (error as Error).message })
}

app.post<{ Body: { since?: string } }>('/amazon/sync/start', async (request, reply) => {
  if (!isConfigured()) {
    return reply.code(503).send({
      ok: false,
      error: 'Proxy sem credenciais da Amazon.',
      detail: `Preencha no .env: ${missingKeys().join(', ')}`,
    })
  }

  const since = request.body?.since
  const valid =
    since && /^\d{4}-\d{2}-\d{2}$/.test(since)
      ? since
      : new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)

  try {
    return { ok: true, resource: 'sync', ...(await startSync(valid)) }
  } catch (error) {
    return sendSyncError(request, reply, error)
  }
})

app.post('/amazon/sync/step', async (request, reply) => {
  if (!isConfigured()) {
    return reply.code(503).send({
      ok: false,
      error: 'Proxy sem credenciais da Amazon.',
      detail: `Preencha no .env: ${missingKeys().join(', ')}`,
    })
  }

  try {
    return { ok: true, resource: 'sync', ...(await stepSync()) }
  } catch (error) {
    return sendSyncError(request, reply, error)
  }
})

app.post('/amazon/sync/cancel', async () => ({ ok: true, resource: 'sync', ...(await cancelSync()) }))

app.get('/amazon/sync/status', async () => ({ ok: true, resource: 'sync', ...(await statusSync()) }))

app.get<{ Params: { resource: string }; Querystring: { since?: string } }>(
  '/amazon/:resource',
  async (request, reply) => {
    const resource = request.params.resource as (typeof resourceKeys)[number]

    if (!resourceKeys.includes(resource)) {
      return reply.code(404).send({
        ok: false,
        error: `Recurso desconhecido: ${resource}`,
        detail: `Use um destes: ${resourceKeys.join(', ')}`,
      })
    }

    if (!isConfigured()) {
      return reply.code(503).send({
        ok: false,
        error: 'Proxy sem credenciais da Amazon.',
        detail: `Preencha no .env: ${missingKeys().join(', ')}`,
      })
    }

    const querySince = request.query.since
    const since =
      querySince && /^\d{4}-\d{2}-\d{2}$/.test(querySince)
        ? querySince
        : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

    try {
      const result = await handlers[resource](since)
      return { ok: true, resource, since, fetchedAt: new Date().toISOString(), ...result }
    } catch (error) {
      if (error instanceof SpApiError) {
        return reply.code(502).send({ ok: false, error: error.message, detail: error.detail })
      }
      throw error
    }
  },
)

/* --- Login e recuperação de senha (Fase 3) --- */

const MIN_PASSWORD = 8
let lastForgotAt = 0

app.post<{ Body: { email?: string; password?: string } }>('/auth/login', async (request, reply) => {
  const email = String(request.body?.email ?? '').trim().toLowerCase()
  const password = String(request.body?.password ?? '')
  if (!email || !password) {
    return reply.code(400).send({ ok: false, error: 'Informe e-mail e senha.' })
  }

  const user = await findUserByEmail(email)
  let valid = false
  if (user) {
    valid = verifyPassword(password, user.passwordSalt, user.passwordHash)
  } else {
    /* gasta o mesmo tempo de scrypt de um login válido: resposta idêntica
       para e-mail inexistente e senha errada */
    burnPasswordTime(password)
  }

  if (!user || !valid) {
    return reply.code(401).send({ ok: false, error: 'E-mail ou senha incorretos.' })
  }

  reply.header('set-cookie', sessionCookie(request, signSession(user.id)))
  return { ok: true, user: { email: user.email, name: user.name } }
})

/* Cadastro de nova conta (Fase 3): valida campos, impede e-mail duplicado
   e cria o usuário com scrypt (mesmo mecanismo do login). A conta já nasce
   utilizável — o requisito é permitir login imediato com as novas credenciais. */
app.post<{ Body: { name?: string; email?: string; password?: string } }>(
  '/auth/register',
  async (request, reply) => {
    const name = String(request.body?.name ?? '').trim()
    const email = String(request.body?.email ?? '').trim().toLowerCase()
    const password = String(request.body?.password ?? '')

    if (!name || !email || !password) {
      return reply.code(400).send({ ok: false, error: 'Preencha todos os campos.' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ ok: false, error: 'Informe um e-mail válido.' })
    }
    if (password.length < MIN_PASSWORD) {
      return reply
        .code(400)
        .send({ ok: false, error: `A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.` })
    }

    const existing = await findUserByEmail(email)
    if (existing) {
      return reply.code(409).send({ ok: false, error: 'Este e-mail já está cadastrado.' })
    }

    const { salt, hash } = hashPassword(password)
    await createUser(email, name, salt, hash)

    return { ok: true, message: 'Conta criada com sucesso! Já pode fazer login.' }
  },
)

app.post('/auth/logout', async (request, reply) => {
  reply.header('set-cookie', clearSessionCookie(request))
  return { ok: true }
})

app.get('/auth/me', async (request) => {
  if ((await countUsers()) === 0) return { ok: true, authed: false, needsSetup: true }
  const session = readSessionCookie(request)
  if (!session) return { ok: true, authed: false }
  const user = await findUserById(session.uid)
  if (!user) return { ok: true, authed: false }
  return { ok: true, authed: true, user: { email: user.email, name: user.name } }
})

app.post<{ Body: { email?: string } }>('/auth/forgot', async (request) => {
  const email = String(request.body?.email ?? '').trim().toLowerCase()
  /* Sempre a mesma resposta, exista ou não a conta — e com cooldown para o
     endpoint não virar bomba de e-mail. */
  const message = 'Se esse e-mail tiver uma conta, o link de recuperação chega em instantes.'
  if (!email || Date.now() - lastForgotAt < 15_000) return { ok: true, message }

  lastForgotAt = Date.now()
  const user = await findUserByEmail(email)
  if (user) {
    const { token, tokenHash } = newResetToken()
    await setUserReset(user.id, tokenHash, new Date(Date.now() + 30 * 60_000).toISOString())
    const link = `${config.appBaseUrl}?reset=${encodeURIComponent(token)}`
    const { sent } = await sendRecoveryEmail({ to: user.email, name: user.name || undefined, link })
    if (!sent) request.log.warn({ to: user.email }, 'link de recuperação não enviado (ver log [email])')
  }
  return { ok: true, message }
})

app.post<{ Body: { token?: string; password?: string } }>('/auth/reset', async (request, reply) => {
  const token = String(request.body?.token ?? '').trim()
  const password = String(request.body?.password ?? '')
  if (!token) {
    return reply.code(400).send({ ok: false, error: 'Link de recuperação inválido.' })
  }
  if (password.length < MIN_PASSWORD) {
    return reply
      .code(400)
      .send({ ok: false, error: `A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.` })
  }

  const user = await findUserByResetHash(hashResetToken(token))
  if (!user?.resetExpires || Date.parse(user.resetExpires) < Date.now()) {
    return reply
      .code(400)
      .send({ ok: false, error: 'Link de recuperação inválido ou expirado. Peça um novo.' })
  }

  const { salt, hash } = hashPassword(password)
  await setUserPassword(user.id, salt, hash)
  return { ok: true }
})

app.setNotFoundHandler(async (request, reply) => {
  const path = request.url.split('?')[0]
  const isApi = path.startsWith('/amazon') || path.startsWith('/db') || path.startsWith('/health') || path.startsWith('/auth')
  if (isApi || !hasFront || request.method !== 'GET') {
    return reply.code(404).send({ ok: false, error: `Rota desconhecida: ${path}` })
  }
  return reply
    .type('text/html; charset=utf-8')
    .send(readFileSync(resolve(distDir, 'index.html'), 'utf8'))
})

/* Conta administradora das envs WF_ADMIN_*: criada no boot.
   - Se já existir ninguém, cria automaticamente.
   - Se a env FORCE_ADMIN_USER=1, cria mesmo existindo registro (útil para testes).
   - Depois disso a senha muda pelo fluxo "esqueci a senha". */
async function ensureAdminUser() {
  if (!config.adminEmail || !config.adminPassword) return
  const already = await countUsers()
  if (already > 0 && !(process.env.FORCE_ADMIN_USER === '1')) return
  const { salt, hash } = hashPassword(config.adminPassword)
  await createUser(config.adminEmail, '', salt, hash)
  console.log(`[auth] Conta administradora criada: ${config.adminEmail}${
    already > 0 ? ' (sobrescrita/forçada)' : ' (novo cadastro)'
  }`)
}

try {
  await ensureAdminUser()
  if ((await countUsers()) === 0) {
    console.warn(
      '[auth] Nenhuma conta de usuário. Defina WF_ADMIN_EMAIL e WF_ADMIN_PASSWORD (e RESEND_API_KEY) para liberar o login.',
    )
  }
} catch (error) {
  console.error('[auth] Falha ao preparar contas:', (error as Error).message)
}

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
