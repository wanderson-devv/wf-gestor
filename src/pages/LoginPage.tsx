import { useMemo, useState, type FormEvent } from 'react'
import { Loader2, LockKeyhole, Mail, ArrowLeft, CheckCircle2, ShieldAlert } from 'lucide-react'
import type { AuthApi } from '../integrations'

/* Tela de login (Fase 3): entrar, pedir o link de recuperação e redefinir a
   senha pelo token vindo em ?reset=<token> na URL do site. */

type Mode = 'login' | 'forgot' | 'reset'

function readResetToken(): string {
  if (typeof location === 'undefined') return ''
  return new URLSearchParams(location.search).get('reset') ?? ''
}

function clearResetParam() {
  if (typeof history === 'undefined') return
  const url = new URL(location.href)
  if (!url.searchParams.has('reset')) return
  url.searchParams.delete('reset')
  history.replaceState({}, '', url.toString())
}

const MIN_PASSWORD = 8

export default function LoginPage({ auth }: { auth: AuthApi }) {
  const token = useMemo(readResetToken, [])
  const initialMode: Mode = token ? 'reset' : 'login'
  const [mode, setMode] = useState<Mode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const goLogin = () => {
    setMode('login')
    setError('')
    setNotice('')
    setPassword('')
    setConfirm('')
    clearResetParam()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'login') {
        await auth.login(email.trim(), password)
        return
      }

      if (mode === 'forgot') {
        const message = await auth.forgot(email.trim())
        setNotice(message || 'Se esse e-mail tiver uma conta, o link de recuperação chega em instantes.')
        return
      }

      if (password.length < MIN_PASSWORD) {
        throw new Error(`A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.`)
      }
      if (password !== confirm) {
        throw new Error('As duas senhas não coincidem.')
      }
      await auth.reset(token, password)
      clearResetParam()
      setNotice('Senha redefinida com sucesso. Entre com a nova senha.')
      setMode('login')
      setConfirm('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha inesperada.')
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'login' ? 'Entrar na conta' : mode === 'forgot' ? 'Recuperar senha' : 'Nova senha'
  const subtitle =
    mode === 'login'
      ? 'Acompanhe vendas, estoque e anúncios da sua loja Amazon.'
      : mode === 'forgot'
        ? 'Enviamos um link por e-mail para você escolher outra senha.'
        : 'Escolha uma nova senha para a sua conta.'

  return (
    <div className="login-screen">
      <div className="login-card">
        <a className="brand login-brand" href="#top">
          <span>WF</span>
          <b>Gestor</b>
        </a>

        <span className="eyebrow">Área restrita</span>
        <h1>{title}</h1>
        <p className="login-sub">{subtitle}</p>

        {auth.needsSetup && (
          <div className="login-alert warn">
            <ShieldAlert size={15} />
            <span>
              {auth.message} {auth.hint}
            </span>
          </div>
        )}
        {auth.offline && !auth.needsSetup && (
          <div className="login-alert warn">
            <ShieldAlert size={15} />
            <span>
              {auth.message} {auth.hint}
            </span>
          </div>
        )}
        {error && <div className="login-alert error">{error}</div>}
        {notice && (
          <div className="login-alert ok">
            <CheckCircle2 size={15} />
            <span>{notice}</span>
          </div>
        )}

        <form className="login-form" onSubmit={submit}>
          {mode !== 'reset' && (
            <label>
              <span>E-mail</span>
              <div className="login-field">
                <Mail size={15} />
                <input
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="voce@empresa.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </label>
          )}

          {mode !== 'forgot' && (
            <label>
              <span>{mode === 'reset' ? 'Nova senha' : 'Senha'}</span>
              <div className="login-field">
                <LockKeyhole size={15} />
                <input
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </label>
          )}

          {mode === 'reset' && (
            <label>
              <span>Confirmar nova senha</span>
              <div className="login-field">
                <LockKeyhole size={15} />
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </div>
            </label>
          )}

          <button className="primary full lg" type="submit" disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />}
            {mode === 'login' ? 'Entrar' : mode === 'forgot' ? 'Enviar link' : 'Redefinir senha'}
          </button>
        </form>

        <div className="login-links">
          {mode === 'login' && (
            <button className="text-button" type="button" onClick={() => { setMode('forgot'); setError(''); setNotice('') }}>
              Esqueci minha senha
            </button>
          )}
          {mode !== 'login' && (
            <button className="text-button" type="button" onClick={goLogin}>
              <ArrowLeft size={13} /> Voltar para o login
            </button>
          )}
        </div>

        <p className="login-foot">
          <LockKeyhole size={12} /> Sessão protegida por cookie de 30 dias — saia a qualquer momento pelo perfil.
        </p>
      </div>
    </div>
  )
}
