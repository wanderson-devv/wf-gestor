import { useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { brl, num, pct } from '../data'
import {
  ALL_ORDERS_SINCE,
  FINANCE_SINCE,
  enrichSales,
  useAmazonFinance,
  useAmazonSales,
  useAmazonSkus,
} from '../integrations'
import { PageHeader, Panel, StatTile, TabBar } from '../components/ui'

const tabs = ['Curva ABC', 'Produtos rentáveis', 'Top 15', 'Reembolso']

const usable = (sku?: string) => Boolean(sku) && sku !== '-' && sku !== '—'

type SkuRow = {
  sku: string
  name: string
  units: number
  revenue: number
  avgPrice: number
  cost: number | null
  taxRate: number | null
  margin: number | null
  share: number
  cumulative: number
  curve: 'A' | 'B' | 'C'
}

type RefundRow = {
  sku: string
  name: string
  vendidas: number
  reembolsadas: number
  faturado: number
  reembolsado: number
  taxa: number
  risco: 'Normal' | 'Monitorar' | 'Atenção' | 'Alto risco'
}

const riskTone: Record<RefundRow['risco'], string> = {
  Normal: 'tag-ok',
  Monitorar: 'tag-info',
  'Atenção': 'tag-warn',
  'Alto risco': 'tag-bad',
}

export default function AnalyticsPage() {
  const [tab, setTab] = useState(tabs[0])
  const finance = useAmazonFinance(FINANCE_SINCE)
  const amazon = useAmazonSales(ALL_ORDERS_SINCE)
  const { skus: skuMeta } = useAmazonSkus()

  const source = useMemo(
    () => enrichSales(amazon.sales, finance.orders, skuMeta),
    [amazon.sales, finance.orders, skuMeta],
  )

  const rows: SkuRow[] = useMemo(() => {
    const sorted = [...finance.skus].sort((a, b) => b.revenue - a.revenue)
    const total = sorted.reduce((sum, item) => sum + item.revenue, 0)
    let accumulator = 0
    return sorted.map((item) => {
      const share = total > 0 ? (item.revenue / total) * 100 : 0
      accumulator += share
      const meta = skuMeta[item.sku]
      const cost = meta?.cost ?? null
      const taxRate = meta?.tax
      const avgPrice = item.units > 0 ? item.revenue / item.units : 0
      const taxUnit = taxRate != null ? (avgPrice * taxRate) / 100 : 0
      const margin =
        cost != null && avgPrice > 0 ? ((avgPrice - taxUnit - cost) / avgPrice) * 100 : null
      const curve: SkuRow['curve'] = accumulator <= 80 ? 'A' : accumulator <= 95 ? 'B' : 'C'
      return {
        sku: item.sku,
        name: meta?.name || item.sku,
        units: item.units,
        revenue: item.revenue,
        avgPrice,
        cost,
        taxRate: taxRate ?? null,
        margin,
        share,
        cumulative: accumulator,
        curve,
      }
    })
  }, [finance.skus, skuMeta])

  const totalRevenue = rows.reduce((sum, item) => sum + item.revenue, 0)
  const totalUnits = rows.reduce((sum, item) => sum + item.units, 0)
  const comMargem = rows.filter((item) => item.margin != null)
  const melhorMargem = comMargem.length
    ? comMargem.reduce((best, item) => ((item.margin ?? -Infinity) > (best.margin ?? -Infinity) ? item : best))
    : null
  const semCusto = rows.length - comMargem.length
  const vazio = finance.status !== 'live' && rows.length === 0

  const top = useMemo(() => rows.slice(0, 15), [rows])
  const topRevenue = top.reduce((sum, item) => sum + item.revenue, 0)
  const topUnits = top.reduce((sum, item) => sum + item.units, 0)
  const topShare = totalRevenue > 0 ? (topRevenue / totalRevenue) * 100 : 0

  /* Reembolso por produto: unidades devolvidas (status "Devolvido") e valores
     estornados no extrato (refunds < 0), rateados quando o pedido tem vários
     SKUs. Janela = extrato, para bater com faturamento e unidades. */
  const refund = useMemo(() => {
    const janela = source.filter((sale) => sale.date >= FINANCE_SINCE)

    /* Faturamento vem das vendas da janela (sale.gross) e não do extrato:
       pedido cancelado/devolvido antes de faturar não gera evento no
       extrato e apareceria como R$ 0,00. */
    const vendidas = new Map<string, number>()
    const faturado = new Map<string, number>()
    janela.forEach((sale) => {
      if (!usable(sale.sku)) return
      vendidas.set(sale.sku, (vendidas.get(sale.sku) ?? 0) + sale.qty)
      faturado.set(sale.sku, (faturado.get(sale.sku) ?? 0) + sale.gross)
    })

    const devolvidas = new Map<string, number>()
    janela.forEach((sale) => {
      if (sale.status !== 'Devolvido' || !usable(sale.sku)) return
      devolvidas.set(sale.sku, (devolvidas.get(sale.sku) ?? 0) + sale.qty)
    })

    const estornos = new Map<string, number>()
    const porId = new Map(janela.map((sale) => [sale.id, sale]))
    Object.entries(finance.orders).forEach(([id, entry]) => {
      if (!(entry.refunds < 0)) return
      const sale = porId.get(id)
      if (!sale) return
      const doPedido = entry.skus.filter(usable)
      const alvos = doPedido.length ? doPedido : usable(sale.sku) ? [sale.sku] : []
      if (!alvos.length) return
      const share = -entry.refunds / alvos.length
      alvos.forEach((sku) => estornos.set(sku, (estornos.get(sku) ?? 0) + share))
    })

    const linhas: RefundRow[] = [...new Set([...devolvidas.keys(), ...estornos.keys()])]
      .map((sku) => {
        const vendidasUnidades = vendidas.get(sku) ?? 0
        const reembolsadas = devolvidas.get(sku) ?? 0
        const reembolsado = Math.round((estornos.get(sku) ?? 0) * 100) / 100
        const taxa = vendidasUnidades > 0 ? (reembolsadas / vendidasUnidades) * 100 : 100
        const risco: RefundRow['risco'] =
          taxa >= 30 ? 'Alto risco' : taxa >= 15 ? 'Atenção' : taxa >= 10 ? 'Monitorar' : 'Normal'
        return {
          sku,
          name: skuMeta[sku]?.name || sku,
          vendidas: vendidasUnidades,
          reembolsadas,
          faturado: faturado.get(sku) ?? 0,
          reembolsado,
          taxa,
          risco,
        }
      })
      .sort((a, b) => b.taxa - a.taxa || b.reembolsado - a.reembolsado)

    const totalPedidos = janela.length
    const devolvidos = janela.filter((sale) => sale.status === 'Devolvido').length
    return {
      linhas,
      totalPedidos,
      devolvidos,
      taxaGeral: totalPedidos > 0 ? (devolvidos / totalPedidos) * 100 : 0,
      faturamentoPerdido: linhas.reduce((sum, item) => sum + item.reembolsado, 0),
    }
  }, [source, finance, skuMeta])

  const criticos = refund.linhas.filter((item) => item.taxa >= 15)
  const semPedidos = amazon.status !== 'live' && amazon.sales.length === 0

  return (
    <>
      <PageHeader
        eyebrow="Analítico"
        title="Análises de desempenho"
        description="Curva ABC, rentabilidade, ranking dos 15 mais vendidos e reembolsos — tudo sobre a receita real de cada SKU no extrato da Amazon."
      />

      <TabBar items={tabs} active={tab} onChange={setTab} />

      {vazio && (
        <div className="data-mode is-demo">
          <b>Sem dados no momento.</b> {finance.message}
          {finance.hint ? ` · ${finance.hint}` : ''}
        </div>
      )}

      {tab === 'Curva ABC' && (
        <>
          <section className="metrics">
            <StatTile label="SKUs com faturamento" value={num(rows.length)} hint="no extrato" />
            <StatTile label="Receita total" value={brl(totalRevenue)} hint="recorte do extrato" />
            <StatTile label="Unidades" value={num(totalUnits)} hint="somadas por SKU" />
            <StatTile
              label="Concentração curva A"
              value={pct(rows.filter((item) => item.curve === 'A').reduce((sum, item) => sum + item.share, 0))}
              hint="participação no faturamento"
              tone="positive"
            />
          </section>

          <Panel title="Classificação por faturamento" hint="Acumulado decrescente" className="sales-panel">
            {rows.length === 0 ? (
              <p className="breakdown-note">Nenhum SKU com faturamento no extrato.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Produto</th>
                      <th>SKU</th>
                      <th>Unidades</th>
                      <th>Faturamento</th>
                      <th>Participação</th>
                      <th>Acumulado</th>
                      <th>Curva</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((product, index) => (
                      <tr key={product.sku}>
                        <td className="mono">{index + 1}</td>
                        <td>
                          <b>{product.name}</b>
                        </td>
                        <td className="order">{product.sku}</td>
                        <td>{num(product.units)}</td>
                        <td>{brl(product.revenue)}</td>
                        <td>
                          <div className="mini-bar">
                            <i style={{ width: `${Math.min(product.share * 2.4, 100)}%` }} className={`fill-${product.curve}`} />
                          </div>
                          <small className="sub">{pct(product.share)}</small>
                        </td>
                        <td className="mono">{pct(product.cumulative)}</td>
                        <td>
                          <span className={`curve-chip curve-chip-${product.curve}`}>{product.curve}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <section className="footnote">
            Leitura operacional: concentre estoque e capital nas curvas A e B; revise preço, descrição ou logística da curva C.
          </section>
        </>
      )}

      {tab === 'Produtos rentáveis' && (
        <>
          <section className="metrics">
            <StatTile label="SKUs ativos" value={num(rows.length)} hint="com faturamento" />
            <StatTile
              label="Melhor margem"
              value={melhorMargem?.margin != null ? pct(melhorMargem.margin) : '—'}
              hint={melhorMargem ? melhorMargem.name : 'cadastre custos em Catálogo'}
              tone="positive"
            />
            <StatTile
              label="Sem custo cadastrado"
              value={num(semCusto)}
              hint="margem indisponível"
              tone={semCusto > 0 ? 'attention' : undefined}
            />
            <StatTile label="Receita total" value={brl(totalRevenue)} hint="recorte analisado" />
          </section>

          <Panel title="Rentabilidade por produto" hint="Preço médio, custo e margem real" className="sales-panel">
            {rows.length === 0 ? (
              <p className="breakdown-note">Nenhum SKU com faturamento no extrato.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Produto</th>
                      <th>Curva</th>
                      <th>Faturamento</th>
                      <th>Unidades</th>
                      <th>Preço médio</th>
                      <th>Custo</th>
                      <th>Imposto</th>
                      <th>Margem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((product) => (
                      <tr key={product.sku}>
                        <td>
                          <b>{product.name}</b>
                          <small className="sub">{product.sku}</small>
                        </td>
                        <td>
                          <span className={`curve-chip curve-chip-${product.curve}`}>{product.curve}</span>
                        </td>
                        <td>{brl(product.revenue)}</td>
                        <td>{num(product.units)}</td>
                        <td>{brl(product.avgPrice)}</td>
                        <td>{product.cost != null ? brl(product.cost) : '—'}</td>
                        <td>{product.taxRate != null ? pct(product.taxRate) : '—'}</td>
                        <td
                          className={
                            product.margin == null ? 'muted' : product.margin > 50 ? 'profit' : product.margin < 20 ? 'loss' : ''
                          }
                        >
                          {product.margin != null ? pct(product.margin) : 'sem custo'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {semCusto > 0 && (
            <section className="footnote">
              {semCusto} SKU{semCusto > 1 ? 's' : ''} sem custo informado — cadastre em Catálogo para liberar a margem.
            </section>
          )}
        </>
      )}

      {tab === 'Top 15' && (
        <>
          <section className="metrics">
            <StatTile label="Receita do top 15" value={brl(topRevenue)} hint="faturamento no período" tone="positive" />
            <StatTile label="Participação" value={pct(topShare)} hint="no faturamento total" />
            <StatTile label="Unidades" value={num(topUnits)} hint="vendidas no ranking" />
            <StatTile label="Produtos no ranking" value={num(top.length)} hint={`de ${rows.length} com venda`} />
          </section>

          <Panel title="Top 15 produtos" hint="Ordenado por faturamento" className="sales-panel">
            {top.length === 0 ? (
              <p className="breakdown-note">Nenhum SKU com faturamento no extrato.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Produto</th>
                      <th>SKU</th>
                      <th>Unidades</th>
                      <th>Faturamento</th>
                      <th>Preço médio</th>
                      <th>Participação</th>
                      <th>Curva</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.map((product, index) => (
                      <tr key={product.sku}>
                        <td className="mono medal">
                          {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : index + 1}
                        </td>
                        <td>
                          <b>{product.name}</b>
                        </td>
                        <td className="order">{product.sku}</td>
                        <td>{num(product.units)}</td>
                        <td>{brl(product.revenue)}</td>
                        <td>{brl(product.avgPrice)}</td>
                        <td>
                          <div className="mini-bar">
                            <i style={{ width: `${Math.min(product.share * 2.4, 100)}%` }} className={`fill-${product.curve}`} />
                          </div>
                          <small className="sub">{pct(product.share)}</small>
                        </td>
                        <td>
                          <span className={`curve-chip curve-chip-${product.curve}`}>{product.curve}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <section className="footnote">
            Os três primeiros levam medalha — é onde estoque, anúncios e preço têm mais retorno.
          </section>
        </>
      )}

      {tab === 'Reembolso' && (
        <>
          <section className="metrics">
            <StatTile
              label="Taxa geral de reembolso"
              value={pct(refund.taxaGeral)}
              hint={`${refund.devolvidos} de ${refund.totalPedidos} pedidos`}
              tone={refund.taxaGeral >= 15 ? 'attention' : 'positive'}
            />
            <StatTile
              label="Faturamento reembolsado"
              value={brl(refund.faturamentoPerdido)}
              hint="estornos no extrato"
              tone={refund.faturamentoPerdido > 0 ? 'attention' : 'neutral'}
            />
            <StatTile label="SKUs com reembolso" value={num(refund.linhas.length)} hint="com devolução ou estorno" />
            <StatTile
              label="Produto mais crítico"
              value={refund.linhas[0] ? pct(refund.linhas[0].taxa) : '—'}
              hint={refund.linhas[0]?.name ?? 'nenhum reembolso no período'}
              tone={refund.linhas[0] && refund.linhas[0].taxa >= 15 ? 'attention' : 'positive'}
            />
          </section>

          {semPedidos && (
            <div className="data-mode is-demo">
              <b>Sem pedidos carregados.</b> {amazon.message}
              {amazon.hint ? ` · ${amazon.hint}` : ''}
            </div>
          )}

          <Panel title="Reembolso por produto" hint="Vendas vs devoluções" className="sales-panel">
            {refund.linhas.length === 0 ? (
              <p className="breakdown-note is-ok">
                Nenhum reembolso no período — nenhum pedido devolvido ou estornado.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="wide">
                  <thead>
                    <tr>
                      <th>Produto</th>
                      <th>SKU</th>
                      <th>Vendidas</th>
                      <th>Reembolsadas</th>
                      <th>Faturamento</th>
                      <th>Reembolsado</th>
                      <th>Taxa</th>
                      <th>Risco</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refund.linhas.map((row) => (
                      <tr key={row.sku}>
                        <td>
                          <b>{row.name}</b>
                        </td>
                        <td className="order">{row.sku}</td>
                        <td>{num(row.vendidas)}</td>
                        <td>{num(row.reembolsadas)}</td>
                        <td>{brl(row.faturado)}</td>
                        <td className={row.reembolsado > 0 ? 'loss' : undefined}>{brl(row.reembolsado)}</td>
                        <td className={row.taxa >= 15 ? 'loss' : ''}>{pct(row.taxa)}</td>
                        <td>
                          <span className={`tag ${riskTone[row.risco]}`}>{row.risco}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {criticos.length > 0 && (
            <section className="footnote">
              <TriangleAlert size={14} /> {criticos.length} SKU{criticos.length > 1 ? 's' : ''} com taxa de reembolso
              ≥15% — acima disso aumenta o risco de revisão da conta. Priorize {criticos[0].name}.
            </section>
          )}
        </>
      )}
    </>
  )
}
