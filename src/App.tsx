import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  Boxes,
  ChartColumn,
  LayoutDashboard,
  LineChart,
  LogOut,
  Menu,
  PackageSearch,
  Plug,
  Settings,
  ShoppingBag,
  WalletCards,
} from 'lucide-react'
import DashboardPage from './pages/DashboardPage'
import SalesPage from './pages/SalesPage'
import CatalogPage from './pages/CatalogPage'
import FinancePage from './pages/FinancePage'
import AnalyticsPage from './pages/AnalyticsPage'
import ChartsPage from './pages/ChartsPage'
import OperationsPage from './pages/OperationsPage'
import IntegrationsPage from './pages/IntegrationsPage'
import SettingsPage from './pages/SettingsPage'
import LoginPage from './pages/LoginPage'
import LiveToast from './components/LiveToast'
import { brl } from './data'
import {
  describeSync,
  loadAppDb,
  prefetchCoreData,
  startAutoSync,
  useAuth,
  useAutoSyncStatus,
  useLiveSales,
  useMinuteTick,
  type AuthApi,
  type LiveSale,
  type LiveStatus,
} from './integrations'
import { startBackgroundSync } from './integrations/background'

type View =
  | 'Visão geral'
  | 'Vendas'
  | 'Catálogo'
  | 'Financeiro'
  | 'Análises'
  | 'Gráficos'
  | 'Operação'
  | 'Integrações'
  | 'Configurações'

const nav: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Visão geral', icon: LayoutDashboard },
  { label: 'Vendas', icon: ShoppingBag },
  { label: 'Catálogo', icon: PackageSearch },
  { label: 'Financeiro', icon: WalletCards },
  { label: 'Análises', icon: LineChart },
  { label: 'Gráficos', icon: ChartColumn },
  { label: 'Operação', icon: Boxes },
  { label: 'Integrações', icon: Plug },
]

const liveLabels: Record<LiveStatus, string> = {
  inicial: 'Conectando…',
  live: 'Ao vivo',
  'sem-proxy': 'Proxy off',
  'aguardando-credenciais': 'Sem credenciais',
  erro: 'Erro de conexão',
}

const hora = (iso: string) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const hoje = new Date().toDateString() === date.toDateString()
  return hoje
    ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
}

const initials = (value?: string) => {
  const source = (value ?? '').trim()
  if (!source) return 'WF'
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? 'W') + (parts[1]?.[0] ?? '')).toUpperCase() || 'WF'
}

function AppShell({ auth }: { auth: AuthApi }) {
  const [view, setView] = useState<View>('Visão geral')
  const live = useLiveSales(30000)
  const sync = useAutoSyncStatus()
  useMinuteTick()
  const [panelOpen, setPanelOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toasts, setToasts] = useState<LiveSale[]>([])
  const notified = useRef<Set<string>>(new Set())
  const panelRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const acknowledgeRef = useRef(live.acknowledge)
  acknowledgeRef.current = live.acknowledge

  const goVendas = () => {
    setView('Vendas')
    setPanelOpen(false)
    setToasts([])
    live.acknowledge()
  }

  const closeToast = (id: string) => {
    setToasts((prev) => prev.filter((sale) => sale.id !== id))
    live.acknowledge(id)
  }

  useEffect(() => {
    const cutoff = Date.now() - 48 * 3600000
    const fresh = live.pending.filter(
      (sale) => !notified.current.has(sale.id) && Date.parse(sale.purchasedAt) >= cutoff,
    )
    if (!fresh.length) return
    fresh.forEach((sale) => notified.current.add(sale.id))
    setToasts((prev) => [...fresh, ...prev].slice(0, 3))
  }, [live.pending])

  useEffect(() => {
    if (!toasts.length) return
    const timer = window.setTimeout(() => {
      const oldest = toasts[toasts.length - 1]
      setToasts((prev) => prev.filter((sale) => sale.id !== oldest.id))
      acknowledgeRef.current(oldest.id)
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [toasts])

  useEffect(() => {
    if (!panelOpen) return
    const onDoc = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (panelRef.current?.contains(target)) return
      if (bellRef.current?.contains(target)) return
      setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [panelOpen])

  useEffect(() => {
    void loadAppDb()
      .finally(() => startAutoSync())
      .finally(() => void startBackgroundSync())
    prefetchCoreData()
  }, [])

  const syncTone = sync.running
    ? 'inicial'
    : !sync.enabled
      ? 'sem-proxy'
      : sync.ok === false
        ? 'erro'
        : sync.ok === true
          ? 'live'
          : 'inicial'
  const syncTitle = [sync.message, sync.hint].filter(Boolean).join(' · ') || 'Sincronização automática com a Amazon'

  const render = () => {
    switch (view) {
      case 'Vendas':
        return <SalesPage />
      case 'Catálogo':
        return <CatalogPage />
      case 'Financeiro':
        return <FinancePage />
      case 'Análises':
        return <AnalyticsPage />
      case 'Gráficos':
        return <ChartsPage />
      case 'Operação':
        return <OperationsPage />
      case 'Integrações':
        return <IntegrationsPage />
      case 'Configurações':
        return <SettingsPage />
      default:
        return (
          <DashboardPage
            onNavigate={(next) => setView(next as View)}
            live={{ sales: live.sales, pending: live.pending }}
          />
        )
    }
  }

  return (
    <main className="shell">
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
        <a className="brand" href="#top" onClick={() => { setView('Visão geral'); setMenuOpen(false) }}>
          <span>WF</span>
          <b>Gestor</b>
        </a>

        <div className="workspace">
          <span className="workspace-dot">A</span>
          <div>
            <small>Loja conectada</small>
            <b>Amazon.com.br</b>
          </div>
        </div>

        <nav>
          {nav.map(({ label, icon: Icon }) => (
            <button className={view === label ? 'active' : ''} key={label} onClick={() => { setView(label); setMenuOpen(false) }}>
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className={view === 'Configurações' ? 'active' : ''} onClick={() => { setView('Configurações'); setMenuOpen(false) }}>
            <Settings size={18} />
            Configurações
          </button>
          <div className="profile">
            <span>{initials(auth.user?.name || auth.user?.email)}</span>
            <div>
              <b>{auth.user?.name || auth.user?.email || 'Conta'}</b>
              <small>Administrador</small>
            </div>
            <button
              className="profile-out"
              type="button"
              title="Sair da conta"
              aria-label="Sair da conta"
              onClick={() => void auth.logout()}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      <section className="content" id="top">
        <header>
          <div className="header-left">
            <button
              className="menu-toggle"
              aria-label="Abrir menu de navegação"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Menu size={19} />
            </button>
            <span className="channel-picker">
              <span className="all-channels">AM</span> Amazon.com.br
            </span>
          </div>
          <div className="header-tools">
            <span className={`live-chip status-${live.status}`} title={live.message}>
              <i />
              {liveLabels[live.status]}
            </span>
            <button
              ref={bellRef}
              className={panelOpen ? 'icon-button bell-active' : 'icon-button'}
              aria-label={
                live.pending.length
                  ? `Notificações: ${live.pending.length} vendas novas`
                  : 'Notificações'
              }
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
            >
              <Bell size={19} />
              {live.pending.length > 0 ? (
                <i className="bell-badge">{live.pending.length > 9 ? '9+' : live.pending.length}</i>
              ) : (
                <i />
              )}
            </button>
            <span className={`live-chip status-${syncTone}`} title={syncTitle}>
              <i />
              {describeSync(sync)}
            </span>
          </div>
          {panelOpen && (
            <div className="live-panel" ref={panelRef}>
              <div className="live-panel-head">
                <div>
                  <span className="eyebrow">Amazon SP-API</span>
                  <h3>Vendas ao vivo</h3>
                </div>
                <span className={`live-chip status-${live.status}`} title={live.message}>
                  <i />
                  {liveLabels[live.status]}
                </span>
              </div>
              <p className="live-panel-status">
                {live.message}
                {live.updatedAt
                  ? ` · atualizado às ${hora(new Date(live.updatedAt).toISOString())}`
                  : ''}
              </p>
              <ul>
                {live.sales.slice(0, 8).map((sale) => (
                  <li
                    key={sale.id}
                    className={live.pending.some((item) => item.id === sale.id) ? 'is-new' : ''}
                  >
                    <div>
                      <b>{sale.product ?? 'Pedido na Amazon'}</b>
                      <small>
                        {hora(sale.purchasedAt)} · {sale.status}
                      </small>
                    </div>
                    <strong>{brl(sale.amount)}</strong>
                  </li>
                ))}
                {!live.sales.length && (
                  <li className="empty">Nenhum pedido nas últimas 48 horas.</li>
                )}
              </ul>
              <div className="live-panel-foot">
                <button
                  className="ghost"
                  onClick={() => live.acknowledge()}
                  disabled={!live.pending.length}
                >
                  Marcar como lidas
                </button>
                <button className="primary" onClick={goVendas}>
                  Ver vendas
                </button>
              </div>
            </div>
          )}
        </header>
        <div className="page" key={view}>
          {render()}
        </div>
      </section>

      {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} />}
      <LiveToast sales={toasts} onOpen={goVendas} onClose={closeToast} />
    </main>
  )
}

function Splash() {
  return (
    <div className="login-screen">
      <div className="login-card login-splash">
        <a className="brand login-brand" href="#top">
          <span>WF</span>
          <b>Gestor</b>
        </a>
        <p className="login-sub">Verificando sua sessão…</p>
      </div>
    </div>
  )
}

/* Guarda de sessão: checando → splash, sem sessão → LoginPage, com sessão →
   o app só monta aqui (os dados e o auto-sync só rodam logado). */
export default function App() {
  const auth = useAuth()

  if (auth.status === 'checking') return <Splash />
  if (auth.status !== 'authed') return <LoginPage auth={auth} />
  return <AppShell auth={auth} />
}
