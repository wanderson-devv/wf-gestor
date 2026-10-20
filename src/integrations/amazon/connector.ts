import type { ChannelConnector, FetchResult, ProbeResult, SyncResource } from '../types'
import { SyncError } from '../types'

const STORE_KEY = 'wf.spApiProxy'
const ENV_URL = (import.meta.env.VITE_SP_API_PROXY as string | undefined) ?? ''
export const DEFAULT_PROXY_URL = 'https://wf-gestor-api.onrender.com'

const normalize = (value: string) => value.trim().replace(/\/+$/, '')

const isLocalHttp = (value: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)

export function readProxyUrl(): string {
  let candidate = ''
  try {
    candidate = localStorage.getItem(STORE_KEY) ?? ''
  } catch {
    /* armazenamento indisponível */
  }
  if (!candidate) candidate = ENV_URL
  const value = normalize(candidate)
  if (!value) return DEFAULT_PROXY_URL
  // Pagina https (GitHub Pages) nao pode chamar http://localhost (mixed content):
  // o fetch seria barrado pelo navegador e o save falharia como "proxy offline".
  const onHttps = typeof location !== 'undefined' && location.protocol === 'https:'
  if (onHttps && isLocalHttp(value)) return DEFAULT_PROXY_URL
  return value
}

export function proxyHint(): string {
  const onSecurePage = typeof location !== 'undefined' && location.protocol === 'https:'
  return onSecurePage
    ? `Sem resposta do proxy em ${DEFAULT_PROXY_URL}. O serviço pode estar acordando (até ~30s) — recarregue em seguida.`
    : `Sem resposta do proxy. Rode “npm run proxy” localmente ou use o proxy na nuvem (${DEFAULT_PROXY_URL}).`
}

export function writeProxyUrl(value: string) {
  try {
    localStorage.setItem(STORE_KEY, normalize(value))
  } catch {
    /* armazenamento indisponível */
  }
}

export class AmazonSpApiConnector implements ChannelConnector {
  readonly channel = 'Amazon' as const

  private get base() {
    return readProxyUrl()
  }

  private assertConfigured() {
    if (!this.base) {
      throw new SyncError(
        'URL do proxy da SP-API não informada.',
        'Informe em “Proxy SP-API” o endereço do serviço server/ rodando com suas credenciais LWA.',
      )
    }
  }

  async probe(): Promise<ProbeResult> {
    this.assertConfigured()
    const response = await fetch(`${this.base}/amazon/health`, { headers: { Accept: 'application/json' } })
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      configured?: boolean
      detail?: string
      error?: string
    }

    if (!response.ok || body.configured === false) {
      throw new SyncError(
        body.error ?? `Proxy respondeu HTTP ${response.status}.`,
        body.detail ?? 'Verifique o .env do proxy (SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, SP_API_REFRESH_TOKEN).',
      )
    }

    return { ok: true, detail: body.detail ?? 'proxy SP-API respondendo' }
  }

  async fetch(resource: SyncResource, since: string): Promise<FetchResult> {
    this.assertConfigured()
    const response = await fetch(`${this.base}/amazon/${resource}?since=${encodeURIComponent(since)}`, {
      headers: { Accept: 'application/json' },
    })
    const body = (await response.json().catch(() => ({}))) as {
      count?: number
      detail?: string
      error?: string
    }

    if (!response.ok) {
      throw new SyncError(body.error ?? `Falha ao consultar ${resource} (HTTP ${response.status}).`, body.detail)
    }

    return { count: Number(body.count ?? 0), detail: body.detail ?? 'SP-API' }
  }
}
