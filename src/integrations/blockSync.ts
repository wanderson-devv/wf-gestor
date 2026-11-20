import { useCallback, useEffect, useRef, useState } from 'react'
import { proxyHint, readProxyUrl } from './amazon/connector'

/* Importação detalhada em blocos: o navegador chama /amazon/sync/step em
   laço, mostrando a barra de progresso, até todos os pedidos terem itens.
   Cada passo respeita o limite da SP-API (0,5 req/s de getOrderItems) — é o
   caminho que evita o HTTP 429 QuotaExceeded. Se a aba fechar no meio, o
   job fica salvo no banco do proxy e a tela oferece "Retomar". */

export type SyncFase = 'idle' | 'listing' | 'items' | 'done' | 'error'

export type SyncProgress = {
  jobId: string | null
  since: string | null
  fase: SyncFase
  processados: number
  total: number
  itens: number
  percentual: number
  concluido: boolean
  avisos: string[]
  iniciadoEm: string | null
  atualizadoEm: string | null
  retomavel: boolean
}

export const IDLE_SYNC: SyncProgress = {
  jobId: null,
  since: null,
  fase: 'idle',
  processados: 0,
  total: 0,
  itens: 0,
  percentual: 0,
  concluido: false,
  avisos: [],
  iniciadoEm: null,
  atualizadoEm: null,
  retomavel: false,
}

type SyncResponse = SyncProgress & { ok?: boolean; error?: string; detail?: string }

async function call(path: string, init?: RequestInit): Promise<SyncProgress> {
  const base = readProxyUrl()
  if (!base) {
    throw new Error('Proxy SP-API não configurado. Informe o endereço na tela Integrações.')
  }

  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new Error(proxyHint())
  }

  const body = (await response.json().catch(() => ({}))) as SyncResponse
  if (!response.ok || body.ok === false) {
    throw new Error(
      [body.error, body.detail].filter(Boolean).join(' · ') || `Proxy respondeu HTTP ${response.status}.`,
    )
  }

  const { ok: _ok, error: _error, detail: _detail, ...progress } = body
  return progress
}

export const fetchSyncStatus = () => call('/amazon/sync/status')

export const startBlockSync = (since: string) =>
  call('/amazon/sync/start', { method: 'POST', body: JSON.stringify({ since }) })

export const stepBlockSync = () => call('/amazon/sync/step', { method: 'POST', body: '{}' })

export const cancelBlockSync = () => call('/amazon/sync/cancel', { method: 'POST', body: '{}' })

export function useBlockSync() {
  const [progress, setProgress] = useState<SyncProgress>(IDLE_SYNC)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const stopRef = useRef(false)
  const runningRef = useRef(false)

  useEffect(() => {
    let alive = true
    fetchSyncStatus()
      .then((status) => {
        if (alive) setProgress(status)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      stopRef.current = true
    }
  }, [])

  const loop = useCallback(async (first: SyncProgress) => {
    if (runningRef.current) return
    runningRef.current = true
    stopRef.current = false
    setRunning(true)
    setError('')

    let current = first
    try {
      while (!stopRef.current && (current.fase === 'items' || current.fase === 'listing')) {
        current = await stepBlockSync()
        setProgress(current)
      }
    } catch (stepError) {
      setError((stepError as Error).message)
      try {
        setProgress(await fetchSyncStatus())
      } catch {
        /* o status é opcional aqui: a mensagem do passo já orienta */
      }
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [])

  const start = useCallback(
    async (since: string) => {
      if (runningRef.current) return
      try {
        const initial = await startBlockSync(since)
        setProgress(initial)
        await loop(initial)
      } catch (startError) {
        setError((startError as Error).message)
      }
    },
    [loop],
  )

  const resume = useCallback(async () => {
    if (runningRef.current) return
    try {
      const status = await fetchSyncStatus()
      setProgress(status)
      await loop(status)
    } catch (resumeError) {
      setError((resumeError as Error).message)
    }
  }, [loop])

  const cancel = useCallback(async () => {
    stopRef.current = true
    try {
      setProgress(await cancelBlockSync())
      setError('')
    } catch (cancelError) {
      setError((cancelError as Error).message)
    }
  }, [])

  return { progress, running, error, start, resume, cancel, clearError: () => setError('') }
}
