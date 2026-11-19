import { config } from './config.js'
import { readStateJson, writeState } from './db.js'
import { getSyncItems, persistSyncItems, putSyncItem, readOrderItems } from './resources.js'
import { SpApiError, spGet } from './spapi.js'

/* Sincronização com a Amazon em blocos.

   Por que em blocos: a SP-API limita getOrderItems a 0,5 req/s, então buscar
   os itens de centenas de pedidos de uma vez estoura a cota (HTTP 429
   QuotaExceeded) e a requisição inteira falha. O trabalho é quebrado em
   passos curtos:

     start  → lista os pedidos do período e cria o job (persistido no banco)
     step   → processa um bloco de itens dentro de um orçamento de tempo e
              devolve o progresso; o navegador chama em laço até concluir
     status → progresso atual, inclusive para retomar após fechar a aba
     cancel → descarta o job

   Como o proxy do WF Gestor é um serviço contínuo (Render), nenhum limite de
   função serverless entra em jogo — o gargalo é só a cota da SP-API, e o
   intervalo de 2,1 s por chamada de itens (em resources.ts) respeita ela. */

export type SyncPhase = 'listing' | 'items' | 'done' | 'error'

export type SyncJobOrder = {
  id: string
  purchasedAt: string
  updatedAt: string
  status: string
  amount: number
  units: number
}

export type SyncJob = {
  id: string
  since: string
  startedAt: string
  updatedAt: string
  phase: SyncPhase
  orders: SyncJobOrder[]
  cursor: number
  avisos: string[]
  semItens: number
}

export type SyncProgress = {
  jobId: string | null
  since: string | null
  fase: SyncPhase | 'idle'
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

type RawOrder = {
  AmazonOrderId?: string
  PurchaseDate?: string
  LastUpdateDate?: string
  OrderStatus?: string
  OrderTotal?: { Amount?: string }
  NumberOfItemsShipped?: number
  NumberOfItemsUnshipped?: number
}

const JOB_KEY = 'sync.job'
const STEP_BUDGET_MS = 12_000
const LIST_MAX_PAGES = 10

const now = () => new Date().toISOString()

function unwrap<T>(response: Record<string, unknown>): T {
  const payload = (response as { payload?: T }).payload
  return (payload ?? response) as T
}

function syncError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

let jobCache: SyncJob | null | undefined
let jobLoading: Promise<SyncJob | null> | null = null

async function loadJob(): Promise<SyncJob | null> {
  if (jobCache !== undefined) return jobCache
  if (!jobLoading) {
    jobLoading = readStateJson<SyncJob>(JOB_KEY)
      .then((raw) => {
        jobCache = raw && Array.isArray(raw.orders) ? raw : null
        return jobCache
      })
      .catch(() => {
        jobCache = null
        return null
      })
  }
  return jobLoading
}

async function saveJob(next: SyncJob | null): Promise<void> {
  jobCache = next
  await writeState(JOB_KEY, JSON.stringify(next))
}

async function progresso(): Promise<SyncProgress> {
  const current = await loadJob()
  if (!current) {
    return {
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
  }

  const store = await getSyncItems()
  let itens = 0
  for (const order of current.orders) itens += store.get(order.id)?.length ?? 0

  const total = current.orders.length
  const processados = Math.min(current.cursor, total)
  return {
    jobId: current.id,
    since: current.since,
    fase: current.phase,
    processados,
    total,
    itens,
    percentual: total ? Math.round((processados / total) * 100) : 100,
    concluido: current.phase === 'done',
    avisos: current.avisos,
    iniciadoEm: current.startedAt,
    atualizadoEm: current.updatedAt,
    retomavel: current.phase === 'items',
  }
}

let stepRunning = false

/* Etapa 1: lista os pedidos do período e cria o job. */
export async function startSync(since: string): Promise<SyncProgress> {
  if (stepRunning) {
    throw syncError(409, 'Um passo da importação está em curso. Aguarde a barra avançar.')
  }

  const createdAfter = new Date(`${since}T00:00:00Z`).toISOString()
  const collected: RawOrder[] = []
  let nextToken: string | undefined

  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const response = (await spGet('/orders/v0/orders', {
      MarketplaceIds: config.marketplaceId,
      CreatedAfter: createdAfter,
      MaxOrdersPerPage: '100',
      NextToken: nextToken,
    })) as Record<string, unknown>

    const payload = unwrap<{ Orders?: RawOrder[]; NextToken?: string }>(response)
    const orders = payload.Orders ?? []
    collected.push(...orders)
    nextToken = payload.NextToken
    if (!nextToken || orders.length === 0) break
  }

  const orders: SyncJobOrder[] = collected
    .filter((order) => order.AmazonOrderId && order.PurchaseDate)
    .map((order) => ({
      id: order.AmazonOrderId as string,
      purchasedAt: order.PurchaseDate as string,
      updatedAt: order.LastUpdateDate ?? '',
      status: order.OrderStatus ?? '',
      amount: Number(order.OrderTotal?.Amount ?? 0) || 0,
      units: (order.NumberOfItemsShipped ?? 0) + (order.NumberOfItemsUnshipped ?? 0),
    }))
    .sort((a, b) => (b.purchasedAt > a.purchasedAt ? 1 : -1))

  const avisos: string[] = []
  if (nextToken) {
    avisos.push(
      'O período tem mais pedidos do que cabe numa importação (limite de 1.000). Sincronize um intervalo menor para completar o histórico.',
    )
  }

  const fresh: SyncJob = {
    id: `job_${Date.now()}`,
    since,
    startedAt: now(),
    updatedAt: now(),
    phase: orders.length ? 'items' : 'done',
    orders,
    cursor: 0,
    avisos,
    semItens: 0,
  }
  await saveJob(fresh)
  return progresso()
}

/* Etapa 2: processa o próximo bloco de itens dentro do orçamento de tempo. */
export async function stepSync(): Promise<SyncProgress> {
  if (stepRunning) throw syncError(409, 'Outro passo da importação já está em curso.')
  stepRunning = true

  try {
    const current = await loadJob()
    if (!current) {
      throw syncError(409, 'Nenhuma importação em andamento. Comece de novo.')
    }
    if (current.phase !== 'items') return progresso()

    const limite = Date.now() + STEP_BUDGET_MS
    while (current.cursor < current.orders.length && Date.now() < limite) {
      const pedido = current.orders[current.cursor]
      /* rethrow:429/5xx abortam o passo sem avançar o cursor — o pedido é
         repetido na retomada em vez de ficar silenciosamente sem itens. */
      const items = await readOrderItems(pedido.id, { rethrow: true })
      if (items?.length) {
        await putSyncItem(pedido.id, items)
      } else if (!items) {
        current.semItens += 1
      }
      current.cursor += 1
    }

    if (current.cursor >= current.orders.length) {
      current.phase = 'done'
      if (current.semItens > 0 && !current.avisos.some((aviso) => aviso.includes('ficaram sem itens'))) {
        current.avisos.push(
          `${current.semItens} pedido(s) ficaram sem itens — confirme no Seller Central se o app tem a permissão de informações de pedido.`,
        )
      }
    }

    current.updatedAt = now()
    /* Itens valem mesmo se o job for cancelado no meio do passo. */
    await persistSyncItems()
    if (jobCache === current) {
      await saveJob(current)
    }
    return progresso()
  } finally {
    stepRunning = false
  }
}

export async function statusSync(): Promise<SyncProgress> {
  return progresso()
}

/* Descarta o job. Pode rodar junto a um passo em curso: o passo percebe que
   o job saiu de cena (jobCache !== current) e não o regrava. */
export async function cancelSync(): Promise<SyncProgress> {
  await saveJob(null)
  return progresso()
}

export function isSpApiError(error: unknown): error is SpApiError {
  return error instanceof SpApiError
}
