import { config } from './config.js'

/* Envio de e-mail via Resend (https://resend.com), usado só para o link de
   recuperação de senha. Sem RESEND_API_KEY o envio é pulado e o aviso fica no
   log do servidor — a rota "esqueci a senha" nunca revela isso para quem
   preencheu o formulário (resposta é sempre a mesma). */

export async function sendRecoveryEmail({
  to,
  name,
  link,
}: {
  to: string
  name?: string
  link: string
}): Promise<{ sent: boolean }> {
  if (!config.resendApiKey) {
    console.warn(
      '[email] RESEND_API_KEY não definida — e-mail não enviado.',
      name ? `Olá${name},` : '',
      'Link de recuperação (visível só neste log):',
      link,
    )
    return { sent: false }
  }

  let response: Response
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.resendFrom,
        to: [to],
        subject: 'Recuperação de senha — WF Gestor',
        html: recoveryHtml({ name, link }),
      }),
    })
  } catch (error) {
    console.error('[email] Falha de rede ao enviar via Resend:', (error as Error).message)
    return { sent: false }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[email] Resend recusou o envio:', response.status, text.slice(0, 300))
    return { sent: false }
  }

  return { sent: true }
}

function recoveryHtml({ name, link }: { name?: string; link: string }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0F172A;">
      <h2 style="color:#059669;margin:0 0 8px;">WF Gestor</h2>
      <p>Olá${name ? `, ${name}` : ''}.</p>
      <p>Recebemos um pedido para redefinir a senha da sua conta. Clique no botão abaixo para escolher uma nova senha. Este link expira em 30 minutos.</p>
      <p style="margin:28px 0;">
        <a href="${link}" style="background:#10b981;color:#04231a;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Redefinir minha senha</a>
      </p>
      <p style="font-size:13px;color:#64748B;">Se você não pediu isso, pode ignorar este e-mail com segurança — sua senha continua a mesma.</p>
    </div>
  `
}
