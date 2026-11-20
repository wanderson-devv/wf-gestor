import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnvFile() {
  const file = resolve(process.cwd(), '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile()

const region = (process.env.SP_API_REGION ?? 'na').toLowerCase() as 'na' | 'eu' | 'fe'

export const endpoints: Record<'na' | 'eu' | 'fe', string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
}

export const config = {
  clientId: process.env.SP_API_CLIENT_ID ?? '',
  clientSecret: process.env.SP_API_CLIENT_SECRET ?? '',
  refreshToken: process.env.SP_API_REFRESH_TOKEN ?? '',
  marketplaceId: process.env.SP_API_MARKETPLACE_ID ?? 'A2Q3Y263D00KWC',
  sellerId: process.env.SP_API_SELLER_ID ?? '',
  region,
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  neonDatabaseUrl: process.env.NEON_DATABASE_URL ?? '',
  /* Login (Fase 3): conta administradora criada no boot, chave mestra de
     sessão, Resend para o link de recuperação e a URL pública do front. */
  adminEmail: (process.env.WF_ADMIN_EMAIL ?? '').trim().toLowerCase(),
  adminPassword: process.env.WF_ADMIN_PASSWORD ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  resendFrom: process.env.RESEND_FROM ?? 'WF Gestor <onboarding@resend.dev>',
  appBaseUrl: (process.env.APP_BASE_URL ?? 'https://wanderson-devv.github.io/wf-gestor/').replace(/\/+$/, ''),
  /* Origens que podem chamar a API com cookie (CORS com credenciais não
     aceita "*"): o site no GitHub Pages e o Vite em dev local. */
  corsOrigin:
    process.env.CORS_ORIGIN ??
    'https://wanderson-devv.github.io,http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173',
}

export const isConfigured = () =>
  Boolean(config.clientId && config.clientSecret && config.refreshToken)

export const missingKeys = () =>
  (['SP_API_CLIENT_ID', 'SP_API_CLIENT_SECRET', 'SP_API_REFRESH_TOKEN'] as const).filter(
    (key) => !process.env[key],
  )
