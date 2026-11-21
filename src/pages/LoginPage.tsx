import { useMemo, useState, type FormEvent } from 'react'
import { Loader2, LockKeyhole, Mail, ArrowLeft, CheckCircle2, ShieldAlert, User } from 'lucide-react'
import type { AuthApi } from '../integrations'

/* Tela de autenticação (Fase 3): entrar, criar conta, recuperar senha e
   redefinir a senha pelo token vindo em ?reset=<token> na URL. */

type Mode = 'login' | 'register' | 'forgot' | 'reset'

const MIN_PASSWORD = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

export default function LoginPage({ auth }: { auth: AuthApi }) {
  const resetToken = useMemo(readResetToken, [])
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  /* Flags derivadas uma única vez por render. Comparar `mode === 'x'`
     dentro de condições já estreitadas no JSX gera o erro TS2367 do
     TypeScript; aqui todas as comparações usam o tipo completo de `mode`. */
  const isLogin = mode === 'login'
  const isRegister = mode === 'register'
  const isForgot = mode === 'forgot'
  const isReset = mode === 'reset'

  const title = isLogin ? 'Entrar na conta' : isRegister ? 'Criar conta' : isForgot ? 'Recuperar senha' : 'Nova senha'
  const subtitle = isLogin
    ? 'Acompanhe vendas, estoque e anúncios da sua loja Amazon.'
    : isRegister
      ? 'Preencha os dados abaixo para criar sua conta.'
      : isForgot
        ? 'Informe seu e-mail para receber o link de recuperação.'
        : 'Escolha uma nova senha para a sua conta.'
  const submitLabel = isLogin ? 'Entrar' : isRegister ? 'Criar minha conta' : isForgot ? 'Enviar link' : 'Redefinir senha'

  const showName = isRegister
  const showEmail = isLogin || isRegister || isForgot
  const showPassword = isLogin || isRegister || isReset
  const showConfirm = isRegister || isReset

  const goTo = (next: Mode) => {
    setMode(next)
    setError('')
    setNotice('')
    setPassword('')
    setConfirmPassword('')
    if (next !== 'reset') clearResetParam()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    setNotice('')

    /* Validações do cliente (o servidor valida de novo). */
    if (isRegister) {
      if (!name.trim()) {
        setError('Informe seu nome completo.')
        return
      }
      if (!EMAIL_RE.test(email.trim())) {
        setError('Informe um e-mail válido.')
        return
      }
      if (password.length < MIN_PASSWORD) {
        setError(`A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.`)
        return
      }
      if (password !== confirmPassword) {
        setError('As senhas não coincidem.')
        return
      }
    }
    if (isReset) {
      if (password.length < MIN_PASSWORD) {
        setError(`A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.`)
        return
      }
      if (password !== confirmPassword) {
        setError('As senhas não coincidem.')
        return
      }
    }

    setBusy(true)
    try {
      if (mode === 'login') {
        await auth.login(email.trim(), password)
        return
      }
      if (mode === 'register') {
        const message = await auth.register(name.trim(), email.trim(), password)
        setName('')
        setPassword('')
        setConfirmPassword('')
        setNotice(message || 'Conta criada com sucesso! Já pode fazer login.')
        setMode('login')
        return
      }
      if (mode === 'forgot') {
        const message = await auth.forgot(email.trim())
        setNotice(message || 'Se esse e-mail tiver uma conta, o link de recuperação chega em instantes.')
        return
      }
      await auth.reset(resetToken, password)
      clearResetParam()
      setNotice('Senha redefinida com sucesso. Entre com a nova senha.')
      setMode('login')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha inesperada.')
    } finally {
      setBusy(false)
    }
  }

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
          {showName && (
            <label>
              <span>Nome completo</span>
              <div className="login-field">
                <User size={15} />
                <input
                  type="text"
                  autoComplete="name"
                  required
                  placeholder="Seu nome"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </label>
          )}

          {showEmail && (
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

          {showPassword && (
            <label>
              <span>{isReset ? 'Nova senha' : 'Senha'}</span>
              <div className="login-field">
                <LockKeyhole size={15} />
                <input
                  type="password"
                  autoComplete={isReset || isRegister ? 'new-password' : 'current-password'}
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </label>
          )}

          {showConfirm && (
            <label>
              <span>{isReset ? 'Confirmar nova senha' : 'Confirmar senha'}</span>
              <div className="login-field">
                <LockKeyhole size={15} />
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
            </label>
          )}

          <button className="primary full lg" type="submit" disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />}
            {submitLabel}
          </button>
        </form>

        <div className="login-links">
          {isLogin && (
            <>
              <button className="text-button" type="button" onClick={() => goTo('register')}>
                Não tem uma conta? Criar conta
              </button>
              <button className="text-button" type="button" onClick={() => goTo('forgot')}>
                Esqueci minha senha
              </button>
            </>
          )}
          {isRegister && (
            <button className="text-button" type="button" onClick={() => goTo('login')}>
              <ArrowLeft size={13} /> Já tem uma conta? Fazer login
            </button>
          )}
          {(isForgot || isReset) && (
            <button className="text-button" type="button" onClick={() => goTo('login')}>
              <ArrowLeft size={13} /> Voltar ao login
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