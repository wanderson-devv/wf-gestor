import { useCallback, useEffect, useState } from 'react'
import { proxyHint, readProxyUrl } from './amazon/connector'

/* Sessão com o proxy: cookie HttpOnly gerado em /auth/*, então todos os
   fetchs do app precisam de credentials: 'include' (o cookie é de outro
   domínio — GitHub Pages x Render). */

export type AuthStatus = 'checking' | 'anon' | 'authed'

export type AuthUser = { email: string; name: string }

export type AuthState = {
  status: AuthStatus
  user?: AuthUser
  needsSetup?: boolean
  offline?: boolean
  message?: string
  hint?: string
}

type MeResponse = {
  ok?: boolean
  authed?: boolean
  needsSetup?: boolean
  user?: AuthUser
  error?: string
  detail?: string
}

export async function fetchAuthMe(): Promise<AuthState> {
  let response: Response
  try {
    response = await fetch(`${readProxyUrl()}/auth/me`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
  } catch {
    return { status: 'anon', offline: true, message: 'Proxy indisponível.', hint: proxyHint() }
  }

  const body = (await response.json().catch(() => ({}))) as MeResponse
  if (!response.ok) {
    return { status: 'anon', message: body.error ?? `Proxy respondeu HTTP ${response.status}.`, hint: body.detail }
  }
  if (body.needsSetup) {
    return {
      status: 'anon',
      needsSetup: true,
      message: 'Nenhuma conta cadastrada no proxy.',
      hint: 'Defina WF_ADMIN_EMAIL e WF_ADMIN_PASSWORD nas variáveis de ambiente do Render para criar a primeira conta.',
    }
  }
  if (body.authed && body.user) return { status: 'authed', user: body.user }
  return { status: 'anon' }
}

async function postJson(path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetch(`${readProxyUrl()}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return { status: 0, data: { error: 'Proxy indisponível.' } }
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, data }
}

function messageOf(fallback: string, data: Record<string, unknown>): string {
  return typeof data.error === 'string' && data.error ? data.error : fallback
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: 'checking' })

  const refresh = useCallback(async () => {
    const next = await fetchAuthMe()
    setState(next)
    return next
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(
    async (email: string, password: string) => {
      const { status, data } = await postJson('/auth/login', { email, password })
      if (status === 0) {
        setState({ status: 'anon', offline: true, message: 'Proxy indisponível.', hint: proxyHint() })
        throw new Error('Proxy indisponível.')
      }
      if (status !== 200) throw new Error(messageOf('Não foi possível entrar.', data))
      await refresh()
    },
    [refresh],
  )

  const logout = useCallback(async () => {
    await postJson('/auth/logout')
    setState({ status: 'anon' })
  }, [])

  const forgot = useCallback(async (email: string) => {
    const { status, data } = await postJson('/auth/forgot', { email })
    if (status === 0) throw new Error('Proxy indisponível.')
    if (status !== 200) throw new Error(messageOf('Não foi possível pedir o link.', data))
    return typeof data.message === 'string' ? data.message : ''
  }, [])

  const reset = useCallback(async (token: string, password: string) => {
    const { status, data } = await postJson('/auth/reset', { token, password })
    if (status === 0) throw new Error('Proxy indisponível.')
    if (status !== 200) throw new Error(messageOf('Não foi possível redefinir a senha.', data))
  }, [])

  const register = useCallback(async (name: string, email: string, password: string) => {
    const { status, data } = await postJson('/auth/register', { name, email, password })
    if (status === 0) throw new Error('Proxy indisponível.')
    if (status !== 200) throw new Error(messageOf('Não foi possível criar conta.', data))
    return typeof data.message === 'string' ? data.message : ''
  }, [])

  return { ...state, refresh, login, logout, forgot, reset, register }
}

export type AuthApi = ReturnType<typeof useAuth>
