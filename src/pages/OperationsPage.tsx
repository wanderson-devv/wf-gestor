import { useCallback, useEffect, useMemo, useState } from 'react'
import { PackageCheck, RefreshCw, Warehouse } from 'lucide-react'
import { brl, num } from '../data'
import { ALL_ORDERS_SINCE, AmazonSpApiConnector, useAmazonSales, useAmazonSkus, useAmazonStock } from '../integrations'
import { PageHeader, Panel, StatTile, TabBar } from '../components/ui'

const SINCE = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
const tabs = ['Estoque FBA', 'Inventário Full (MFN)']

/* Mesmos limiares do Gestor Max: ≤10 crítico, ≤20 baixo. */
const CRITICAL_STOCK = 10
const LOW_STOCK = 20

const usable = (sku?: string) => Boolean(sku) && sku !== '-' && sku !== '—'

type InventoryState =
  | { status: 'inicial' }
  | { status: 'live'; count: number; detail: string }
  | { status: 'erro'; message: string; hint?: string }

type StockLine = {
  sku: string
  name: string
  fba: number
  mfn: number
  total: number
  price: number
  cobertura: number | null
  status: 'OK' | 'Baixo' | 'Crítico' | 'Zerado'
}

const statusTone: Record<StockLine['status'], string> = {
  OK: 'tag-ok',
  Baixo: 'tag-warn',
  Crítico: 'tag-bad',
  Zerado: 'tag-bad',
}

export default function OperationsPage() {
  const [tab, setTab] = useState(tabs[0])
  const [inventory, setInventory] = useState<InventoryState>({ status: 'inicial' })
  const stock = useAmazonStock()
  const amazon = useAmazonSales(ALL_ORDERS_SINCE)
  const { skus: skuMeta } = useAmazonSkus()

  const load = useCallback(async () => {
    setInventory({ status: 'inicial' })
    try {
      const connector = new AmazonSpApiConnector()
      const result = await connector.fetch('inventory', SINCE)
      setInventory({ status: 'live', count: result.count, detail: result.detail })
    } catch (error) {
      setInventory({
        status: 'erro',
        message: error instanceof Error ? error.message : 'Falha ao consultar o estoque.',
        hint: error instanceof Error && 'hint' in error ? (error as { hint?: string }).hint : undefined,
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /* Giro dos últimos 30 dias por SKU — base da cobertura de estoque. */
  const giro30 = useMemo(() => {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const acc = new Map<string, number>()
    amazon.sales.forEach((sale) => {
      if (sale.date < cutoff || sale.status === 'Devolvido' || !usable(sale.sku)) return
      acc.set(sale.sku, (acc.get(sale.sku) ?? 0) + sale.qty)
    })
    return acc
  }, [amazon.sales])

  const linhas: StockLine[] = useMemo(
    () =>
      stock.rows.map((row) => {
        const vendas = giro30.get(row.sku) ?? 0
        const giroDiario = vendas / 30
        const cobertura = giroDiario > 0 ? Math.round(row.total / giroDiario) : null
        const status: StockLine['status'] =
          row.total === 0
            ? 'Zerado'
            : row.total <= CRITICAL_STOCK
              ? 'Crítico'
              : row.total <= LOW_STOCK
                ? 'Baixo'
                : 'OK'
        return {
          sku: row.sku,
          name: skuMeta[row.sku]?.name || row.title || row.sku,
          fba: row.fba,
          mfn: row.mfn,
          total: row.total,
          price: row.price,
          cobertura,
          status,
        }
      }),
    [stock.rows, giro30, skuMeta],
  )

  const unidades = inventory.status === 'live' ? inventory.count : 0
  const totalUnidades = linhas.reduce((sum, line) => sum + line.total, 0)
  const valorEstoque = linhas.reduce((sum, line) => sum + line.total * line.price, 0)
  const reposicao = linhas.filter((line) => line.status === 'Zerado' || line.status === 'Crítico').length

  const atualizar = () => {
    void load()
    stock.refresh()
  }

  return (
    <>
      <PageHeader
        eyebrow="Operação"
        title="Estoque"
        description="Posição real por SKU: envio próprio (MFN) e FBA direto da SP-API, com cobertura calculada pelo giro dos últimos 30 dias."
        action={
          <button className="ghost lg" onClick={atualizar}>
            <RefreshCw size={16} /> Atualizar
          </button>
        }
      />

      <TabBar items={tabs} active={tab} onChange={setTab} />

      {tab === 'Estoque FBA' && (
        <>
          {inventory.status === 'inicial' && <div className="data-mode is-loading">Lendo o estoque FBA da Amazon…</div>}
          {inventory.status === 'erro' && (
            <div className="data-mode is-demo">
              <b>Sem dados no momento.</b> {inventory.message}
              {inventory.hint ? ` · ${inventory.hint}` : ''}
            </div>
          )}

          <section className="metrics">
            <StatTile
              label="Estoque FBA"
              value={num(unidades)}
              hint={inventory.status === 'live' ? 'armazenado pela Amazon' : 'aguardando a Amazon'}
            />
            <StatTile label="Modelo de operação" value={unidades > 0 ? 'FBA + MFN' : 'MFN'} hint="envio próprio" />
          </section>

          <Panel title="Posição de estoque" hint="FBA (Fulfillment by Amazon)">
            {inventory.status === 'live' && inventory.count === 0 && (
              <p className="breakdown-note">
                {inventory.detail || 'Sem unidades em estoque FBA — a loja opera com envio próprio (MFN).'}
              </p>
            )}
            {inventory.status === 'live' && inventory.count > 0 && <p className="breakdown-note">{inventory.detail}</p>}
            {inventory.status === 'inicial' && <p className="breakdown-note">Consultando a Amazon…</p>}
          </Panel>

          <section className="footnote">
            <PackageCheck size={14} /> Os dados vêm direto de <span className="mono">/fba/inventory/v1/summaries</span> no
            proxy local.
          </section>
        </>
      )}

      {tab === 'Inventário Full (MFN)' && (
        <>
          {stock.status === 'inicial' && (
            <div className="data-mode is-loading">
              Lendo o estoque completo da Amazon… a primeira leitura gera um relatório e pode levar até 2 minutos.
            </div>
          )}
          {stock.status !== 'inicial' && stock.status !== 'live' && (
            <div className="data-mode is-demo">
              <b>Sem dados no momento.</b> {stock.message}
              {stock.hint ? ` · ${stock.hint}` : ''}
            </div>
          )}
          {stock.aviso && <p className="breakdown-note">{stock.aviso}</p>}

          <section className="metrics">
            <StatTile label="SKUs no inventário" value={num(linhas.length)} hint="listados na loja" />
            <StatTile label="Unidades" value={num(totalUnidades)} hint="MFN + FBA" />
            <StatTile label="Valor em estoque" value={brl(valorEstoque)} hint="pelo preço do anúncio" />
            <StatTile
              label="Requer reposição"
              value={num(reposicao)}
              hint={`zerado ou ≤ ${CRITICAL_STOCK} unidades`}
              tone={reposicao > 0 ? 'attention' : 'positive'}
            />
          </section>

          <Panel title="Inventário por SKU" hint="Envio próprio + FBA · cobertura pelo giro de 30 dias" className="sales-panel">
            {stock.status === 'live' && linhas.length === 0 && (
              <p className="breakdown-note">Nenhum SKU com estoque registrado — confirme os anúncios no Seller Central.</p>
            )}
            {linhas.length > 0 && (
              <div className="table-scroll">
                <table className="wide">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Produto</th>
                      <th>Envio próprio</th>
                      <th>FBA</th>
                      <th>Total</th>
                      <th>Valor</th>
                      <th>Cobertura</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map((line) => (
                      <tr key={line.sku}>
                        <td className="order">{line.sku}</td>
                        <td>
                          <b>{line.name}</b>
                          {line.price > 0 && <small className="sub">{brl(line.price)}</small>}
                        </td>
                        <td>{num(line.mfn)}</td>
                        <td>{num(line.fba)}</td>
                        <td className={line.total <= CRITICAL_STOCK ? 'loss' : ''}>{num(line.total)}</td>
                        <td>{brl(line.total * line.price)}</td>
                        <td>{line.cobertura != null ? `${num(line.cobertura)} dias` : '—'}</td>
                        <td>
                          <span className={`tag ${statusTone[line.status]}`}>{line.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <section className="footnote">
            <Warehouse size={14} /> Envio próprio vem do relatório <span className="mono">GET_MERCHANT_LISTINGS_DATA</span>{' '}
            e o FBA de <span className="mono">/fba/inventory/v1/summaries</span>. Cobertura = estoque ÷ giro médio dos
            últimos 30 dias; ≤{CRITICAL_STOCK} unidades é crítico e ≤{LOW_STOCK} é baixo.
          </section>
        </>
      )}
    </>
  )
}
