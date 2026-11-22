/* Sincronização em segundo plano (APK Android).
   O plugin @transistorsoft/capacitor-background-fetch acorda o app a cada
   ~15 min (limite do Android/iOS), roda a mesma sync do autoSync e avisa o
   sistema com BackgroundFetch.finish(taskId) — sem finish o SO para de
   disparar eventos. Fora do app nativo (web/PWA) é no-op. */
import { Capacitor } from '@capacitor/core'
import { BackgroundFetch } from '@transistorsoft/capacitor-background-fetch'
import { runSyncNow } from './autoSync'

const MINIMUM_FETCH_INTERVAL = 15 // minutos (mínimo permitido pelo SO)

let started = false

export async function startBackgroundSync(): Promise<void> {
  if (started || !Capacitor.isNativePlatform()) return
  started = true

  try {
    const status = await BackgroundFetch.configure(
      {
        minimumFetchInterval: MINIMUM_FETCH_INTERVAL,
        stopOnTerminate: false,
        enableHeadless: true,
        requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
      },
      async (taskId) => {
        // Evento em background: dispara a sync e conclui rápido.
        try {
          await runSyncNow()
        } finally {
          void BackgroundFetch.finish(taskId)
        }
      },
      async (taskId) => {
        // Tempo esgotado pelo SO: conclui imediatamente.
        void BackgroundFetch.finish(taskId)
      },
    )

    if (status !== BackgroundFetch.STATUS_AVAILABLE) {
      console.warn('[BackgroundFetch] indisponível, status =', status)
    }
  } catch (error) {
    // Nunca derruba o app por causa do background.
    console.warn('[BackgroundFetch] falha ao configurar:', error)
  }
}

export function stopBackgroundSync(): void {
  if (!started) return
  started = false
  void BackgroundFetch.stop().catch(() => undefined)
}
