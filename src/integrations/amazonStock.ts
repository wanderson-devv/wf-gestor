import { useCallback, useEffect, useRef, useState } from 'react'
import { proxyHint, readProxyUrl } from './amazon/connector'
import { cacheGet, cacheSet } from './cache'

const STOCK_CACHE_MS = 10 * 60_000

export type StockRow = {
  sku: string
  title?: string
  asin?: string
  fba: number
  mfn: number
  total: number
  price: number
}

export type AmazonStockStatus = 'inicial' | 'live' | 'sem-proxy' | 'aguardando-credenciais' | 'erro'

export type AmazonStockState = {
  status: AmazonStockStatus
  message: string
  hint?: string
  rows: StockRow[]
  aviso?: string
  updatedAt: number
}

/* Inventário Full: FBA (summaries) + envio próprio (relatório da Amazon).
   A primeira leitura gera o relatório e pode levar até 2 minutos. */
export async function fetchAmazonStock(): Promise<AmazonStockState> {
  const base = readProxyUrl()
  if (!base) {
    return {
      status: 'sem-proxy',
      message: 'Proxy SP-API não configurado.',
      hint: proxyHint(),
      rows: [],
      updatedAt: Date.now(),
    }
  }

  let response: Response
  try {
    response = await fetch(`${base}/amazon/stock`, { headers: { Accept: 'application/json' } })
  } catch {
    return {
      status: 'erro',
      message: 'Proxy SP-API indisponível.',
      hint: proxyHint(),
      rows: [],
      updatedAt: Date.now(),
    }
  }

  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    count?: number
    detail?: string
    aviso?: string
    rows?: StockRow[]
    error?: string
  }

  if (response.status === 503) {
    return {
      status: 'aguardando-credenciais',
      message: body.error ?? 'Proxy sem credenciais da Amazon.',
      hint: body.detail,
      rows: [],
      updatedAt: Date.now(),
    }
  }

  if (!response.ok) {
    return {
      status: 'erro',
      message: body.error ?? `Proxy respondeu HTTP ${response.status}.`,
      hint: body.detail,
      rows: [],
      updatedAt: Date.now(),
    }
  }

  return {
    status: 'live',
    message: body.detail ?? `${body.count ?? 0} SKUs em estoque`,
    aviso: body.aviso,
    rows: body.rows ?? [],
    updatedAt: Date.now(),
  }
}

export function useAmazonStock(): AmazonStockState & { refresh: () => void } {
  const key = 'stock'
  const [state, setState] = useState<AmazonStockState>(() => {
    const cached = cacheGet<AmazonStockState>(key, STOCK_CACHE_MS)
    return cached ?? { status: 'inicial', message: 'Lendo o estoque da Amazon…', rows: [], updatedAt: 0 }
  })
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = (requestId.current += 1)
    const next = await fetchAmazonStock()
    if (next.status === 'live') cacheSet(key, next)
    if (id === requestId.current) setState(next)
  }, [key])

  const refresh = useCallback(() => {
    void load()
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.status !== 'erro') return
    const retry = setTimeout(() => {
      void load()
    }, 45_000)
    return () => clearTimeout(retry)
  }, [state.status, state.updatedAt, load])

  return { ...state, refresh }
}
