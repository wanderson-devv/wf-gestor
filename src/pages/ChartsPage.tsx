import { useMemo } from 'react'
import { brl, brlShort, num, pct } from '../data'
import {
  ALL_ORDERS_SINCE,
  FINANCE_SINCE,
  enrichSales,
  useAmazonFinance,
  useAmazonSales,
  useAmazonSkus,
} from '../integrations'
import { PageHeader, Panel, StatTile } from '../components/ui'

type Pt = { x: number; y: number }

/* Mesmos traços do SVG da Visão geral — curva suave e área até o eixo. */
function linePath(points: Pt[]) {
  if (points.length < 2) return ''
  let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    const mid = (current.x + next.x) / 2
    d += ` C${mid.toFixed(1)} ${current.y.toFixed(1)} ${mid.toFixed(1)} ${next.y.toFixed(1)} ${next.x.toFixed(1)} ${next.y.toFixed(1)}`
  }
  return d
}

function areaPath(points: Pt[], height: number) {
  if (points.length < 2) return ''
  const last = points[points.length - 1]
  const first = points[0]
  return `${linePath(points)} L${last.x.toFixed(1)} ${height} L${first.x.toFixed(1)} ${height} Z`
}

const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/* Últimos 12 meses de calendário, incluindo o mês em curso. */
const MESES: { key: string; label: string }[] = (() => {
  const hoje = new Date()
  const lista: { key: string; label: string }[] = []
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(hoje.getFullYear(), hoje.getMonth() - offset, 1)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    lista.push({ key, label: `${MES_CURTO[date.getMonth()]}/${String(date.getFullYear()).slice(2)}` })
  }
  return lista
})()

const MES_SET = new Set(MESES.map((item) => item.key))
/* Mês de partida do extrato: até ele (inclusive) o lucro ainda não está completo. */
const MES_EXTRATO = FINANCE_SINCE.slice(0, 7)

type MonthRow = {
  key: string
  label: string
  revenue: number
  orders: number
  ads: number
  profit: number | null
  margin: number | null
  mpa: number | null
}

export default function ChartsPage() {
  const amazon = useAmazonSales(ALL_ORDERS_SINCE)
  const finance = useAmazonFinance(FINANCE_SINCE)
  const { skus: skuMeta } = useAmazonSkus()

  const source = useMemo(
    () => enrichSales(amazon.sales, finance.orders, skuMeta),
    [amazon.sales, finance.orders, skuMeta],
  )

  const monthly: MonthRow[] = useMemo(() => {
    const acc = new Map<string, { revenue: number; orders: number; profit: number }>()
    MESES.forEach((item) => acc.set(item.key, { revenue: 0, orders: 0, profit: 0 }))

    source.forEach((sale) => {
      const key = sale.date.slice(0, 7)
      const current = acc.get(key)
      if (!current) return
      current.revenue += sale.gross
      current.orders += 1
      if (sale.partial === false) current.profit += sale.net - sale.cost
    })

    const adsPorMes = new Map<string, number>()
    finance.ads.forEach((item) => {
      const key = item.date.slice(0, 7)
      if (!MES_SET.has(key)) return
      adsPorMes.set(key, (adsPorMes.get(key) ?? 0) + item.amount)
    })

    return MESES.map((item) => {
      const current = acc.get(item.key) ?? { revenue: 0, orders: 0, profit: 0 }
      const ads = adsPorMes.get(item.key) ?? 0
      const comExtrato = item.key > MES_EXTRATO
      const profitPreAds = comExtrato ? current.profit : 0
      const lucro = comExtrato ? profitPreAds - ads : null
      return {
        ...item,
        revenue: current.revenue,
        orders: current.orders,
        ads,
        profit: lucro,
        margin: comExtrato && current.revenue > 0 ? (profitPreAds / current.revenue) * 100 : null,
        mpa: comExtrato && current.revenue > 0 ? ((lucro ?? 0) / current.revenue) * 100 : null,
      }
    })
  }, [source, finance.ads])

  const kpi = useMemo(() => {
    const faturamento = monthly.reduce((sum, item) => sum + item.revenue, 0)
    const pedidos = monthly.reduce((sum, item) => sum + item.orders, 0)
    const comExtrato = monthly.filter((item) => item.profit !== null)
    const fatExtrato = comExtrato.reduce((sum, item) => sum + item.revenue, 0)
    const ads = comExtrato.reduce((sum, item) => sum + item.ads, 0)
    const lucroPreAds = comExtrato.reduce((sum, item) => sum + (item.profit ?? 0) + item.ads, 0)
    const lucroPosAds = lucroPreAds - ads
    const ratio = (value: number) => (fatExtrato > 0 ? (value / fatExtrato) * 100 : 0)
    return {
      faturamento,
      pedidos,
      lucro: lucroPosAds,
      ads,
      margem: ratio(lucroPreAds),
      mpa: ratio(lucroPosAds),
      meses: comExtrato.length,
    }
  }, [monthly])

  const channelMix = useMemo(() => {
    const acc = new Map<string, { revenue: number; orders: number }>()
    source.forEach((sale) => {
      if (!MES_SET.has(sale.date.slice(0, 7))) return
      const current = acc.get(sale.channel) ?? { revenue: 0, orders: 0 }
      current.revenue += sale.gross
      current.orders += 1
      acc.set(sale.channel, current)
    })
    const total = [...acc.values()].reduce((sum, item) => sum + item.revenue, 0)
    return [...acc.entries()]
      .map(([channel, value]) => ({
        channel,
        ...value,
        share: total > 0 ? (value.revenue / total) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
  }, [source])

  const adsRows = useMemo(() => {
    const rows = monthly.filter((item) => item.ads > 0)
    const maxAds = Math.max(...rows.map((item) => item.ads), 1)
    return rows.map((item) => ({
      ...item,
      bar: (item.ads / maxAds) * 100,
      tacos: item.revenue > 0 ? (item.ads / item.revenue) * 100 : 0,
    }))
  }, [monthly])

  /* --- Gráfico 1: faturamento (12 meses) + lucro (só com extrato) --- */
  const width = 900
  const height = 260
  const yMax = Math.max(
    1,
    ...monthly.map((item) => item.revenue),
    ...monthly.map((item) => item.profit ?? 0),
  )
  const yMin = Math.min(0, ...monthly.map((item) => item.profit ?? 0))
  const ySpan = yMax - yMin
  const xOf = (index: number, count: number) => (count > 1 ? (index / (count - 1)) * width : width / 2)
  const yOf = (value: number) => height - ((value - yMin) / ySpan) * (height - 18)

  const revenuePts = monthly.map((item, index) => ({ x: xOf(index, monthly.length), y: yOf(item.revenue) }))
  const profitPts = monthly
    .map((item, index) => (item.profit == null ? null : { x: xOf(index, monthly.length), y: yOf(item.profit) }))
    .filter((point): point is Pt => point !== null)

  const labelIndices: number[] = []
  const labelStep = Math.max(1, Math.ceil((monthly.length - 1) / 6))
  for (let index = 0; index < monthly.length; index += labelStep) labelIndices.push(index)
  if (labelIndices[labelIndices.length - 1] !== monthly.length - 1) labelIndices.push(monthly.length - 1)

  /* --- Gráfico 2: margem bruta vs MPA nos meses com extrato --- */
  const trend = monthly.filter((item) => item.margin != null && item.mpa != null && item.revenue > 0)
  const trendMax = Math.max(1, ...trend.map((item) => Math.max(item.margin ?? 0, item.mpa ?? 0)))
  const trendMin = Math.min(0, ...trend.map((item) => Math.min(item.margin ?? 0, item.mpa ?? 0)))
  const trendSpan = trendMax - trendMin
  const trendY = (value: number) => height - ((value - trendMin) / trendSpan) * (height - 18)
  const trendPts = (pick: (item: MonthRow) => number): Pt[] =>
    trend.map((item, index) => ({ x: xOf(index, trend.length), y: trendY(pick(item)) }))

  const stamp = finance.updatedAt
    ? new Date(finance.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : 'sem leitura ainda'

  return (
    <>
      <PageHeader
        eyebrow="Analítico"
        title="Gráficos de tendência"
        description="Faturamento, lucro, margem e MPA mês a mês — tudo calculado sobre os pedidos reais e o extrato da Amazon."
      />

      <div
        className={`data-mode ${amazon.status === 'inicial' ? 'is-loading' : amazon.status === 'live' ? 'is-live' : 'is-demo'}`}
      >
        {amazon.status === 'inicial' && <>Lendo pedidos reais da Amazon…</>}
        {amazon.status === 'live' && (
          <>
            <b>Dados reais da Amazon.</b> {amazon.message} · extrato {finance.message} · atualizado às {stamp}
          </>
        )}
        {amazon.status !== 'inicial' && amazon.status !== 'live' && (
          <>
            <b>Sem dados no momento.</b> {amazon.message}
            {amazon.hint ? ` · ${amazon.hint}` : ''}
          </>
        )}
      </div>

      <section className="metrics">
        <StatTile label="Faturamento" value={brl(kpi.faturamento)} hint="últimos 12 meses" tone="positive" />
        <StatTile label="Pedidos" value={num(kpi.pedidos)} hint="últimos 12 meses" />
        <StatTile label="Lucro" value={brl(kpi.lucro)} hint={`líquido de Ads · ${kpi.meses} meses com extrato`} />
        <StatTile label="Margem bruta" value={pct(kpi.margem)} hint="antes dos anúncios" />
        <StatTile label="MPA" value={pct(kpi.mpa)} hint="margem após anúncios" tone={kpi.mpa < 0 ? 'attention' : 'positive'} />
        <StatTile label="Investido em Ads" value={brl(kpi.ads)} hint="cobranças no período" />
      </section>

      <Panel title="Faturamento e lucro por mês" hint="12 meses · lucro com extrato" className="revenue-panel">
        <div className="chart chart-wide">
          <div className="y-labels">
            {[yMax, yMax - ySpan / 3, yMax - (2 * ySpan) / 3, yMin].map((value) => (
              <span key={value}>{brlShort(value)}</span>
            ))}
          </div>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Faturamento e lucro mês a mês">
            <path className="area area-revenue" d={areaPath(revenuePts, height)} />
            <path className="revenue-line" d={linePath(revenuePts)} />
            {profitPts.length > 0 && <path className="profit-line" d={linePath(profitPts)} />}
          </svg>
          <div className="chart-labels">
            {labelIndices.map((index) => {
              const item = monthly[index]
              const pctX = monthly.length > 1 ? (index / (monthly.length - 1)) * 100 : 50
              const edge = index === 0 ? 'start' : index === monthly.length - 1 ? 'end' : 'center'
              return (
                <span key={item.key} className={`x-${edge}`} style={{ left: `${pctX}%` }}>
                  {item.label}
                </span>
              )
            })}
          </div>
        </div>
        <div className="legend">
          <span>
            <i className="revenue-dot" /> Faturamento
          </span>
          {profitPts.length > 0 && (
            <span>
              <i className="net-dot" /> Lucro (desde {MES_EXTRATO.slice(5)}/{MES_EXTRATO.slice(2, 4)})
            </span>
          )}
          <span className="synced">12 meses · atualizado às {stamp}</span>
        </div>
      </Panel>

      <section className="two-col">
        <Panel title="Faturamento por canal" hint="12 meses">
          {channelMix.length === 0 && <p className="breakdown-note">Sem vendas nos últimos 12 meses.</p>}
          <div className="bars">
            {channelMix.map((item) => (
              <div key={item.channel} className="bar-row campaign">
                <span>{item.channel}</span>
                <b>{brl(item.revenue)}</b>
                <div className="dual-track">
                  <i className="bar-sales" style={{ width: `${Math.min(100, item.share)}%` }} />
                </div>
                <div className="bar-meta">
                  <span>
                    Pedidos <b>{num(item.orders)}</b>
                  </span>
                  <small>{pct(item.share, 0)} do faturamento</small>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Investimento em Ads" hint="Por mês · com TACOS">
          {adsRows.length === 0 && (
            <p className="breakdown-note is-ok">Nenhuma cobrança de Ads nos últimos 12 meses.</p>
          )}
          <div className="bars">
            {adsRows.map((item) => (
              <div key={item.key} className="bar-row campaign">
                <span>{item.label}</span>
                <b>{brl(item.ads)}</b>
                <div className="dual-track">
                  <i className="bar-sales" style={{ width: `${Math.min(100, item.bar)}%` }} />
                </div>
                <div className="bar-meta">
                  <span>
                    TACOS <b>{pct(item.tacos)}</b>
                  </span>
                  <small>faturamento {brl(item.revenue)}</small>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <Panel title="Margem bruta vs MPA" hint="Evolução mensal · meses com extrato" className="revenue-panel">
        {trend.length < 2 ? (
          <p className="breakdown-note">
            Ainda não há dois meses completos com extrato para desenhar a tendência — quando a Amazon publicar as
            taxas, a linha aparece aqui.
          </p>
        ) : (
          <div className="chart chart-wide">
            <div className="y-labels">
              {[trendMax, trendMax - trendSpan / 3, trendMax - (2 * trendSpan) / 3, trendMin].map((value) => (
                <span key={value}>{`${value.toFixed(0)}%`}</span>
              ))}
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Margem bruta e MPA mês a mês">
              <path className="revenue-line" d={linePath(trendPts((item) => item.margin ?? 0))} />
              <path className="mpa-line" d={linePath(trendPts((item) => item.mpa ?? 0))} />
            </svg>
            <div className="chart-labels">
              {trend.map((item, index) => {
                const pctX = trend.length > 1 ? (index / (trend.length - 1)) * 100 : 50
                const edge = index === 0 ? 'start' : index === trend.length - 1 ? 'end' : 'center'
                return (
                  <span key={item.key} className={`x-${edge}`} style={{ left: `${pctX}%` }}>
                    {item.label}
                  </span>
                )
              })}
            </div>
          </div>
        )}
        {trend.length >= 2 && (
          <div className="legend">
            <span>
              <i className="revenue-dot" /> Margem bruta
            </span>
            <span>
              <i className="mpa-dot" /> MPA (após Ads)
            </span>
            <span className="synced">{trend.length} meses com extrato</span>
          </div>
        )}
      </Panel>

      <section className="footnote">
        MPA = margem após investimento em anúncios (lucro menos Ads sobre o faturamento). O lucro desconta comissões,
        taxas, impostos e custo do produto, e o Ads cai no dia exato da cobrança — mesma régua da DRE.
      </section>
    </>
  )
}
