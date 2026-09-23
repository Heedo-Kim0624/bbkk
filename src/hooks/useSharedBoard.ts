import { useEffect, useState, useSyncExternalStore } from 'react'
import { SHARED_API_URL, SHARED_PUBLISHABLE_KEY } from '../config/shared'
import { createSharedBoardClient, SharedBoardController } from '../lib/sharedBoard'

export function useSharedBoard() {
  const [controller] = useState(() => new SharedBoardController(createSharedBoardClient({ url: SHARED_API_URL, publishableKey: SHARED_PUBLISHABLE_KEY })))
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  useEffect(() => {
    controller.start()
    const refresh = () => { if (document.visibilityState === 'visible') controller.refresh() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.getSnapshot().hasUnsavedChanges) return
      event.preventDefault()
      event.returnValue = ''
    }
    const interval = setInterval(refresh, 3000)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('visibilitychange', refresh)
      controller.stop()
    }
  }, [controller])

  return { ...snapshot, setItems: controller.setItems, getItems: controller.getItems, reload: controller.reload, retry: controller.retry }
}
