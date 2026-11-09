// Athena preload bridge (F02): `window.athenaDesktop`, separate from upstream's
// `window.hermesDesktop` so the upstream bridge and its types stay untouched.
// Sandboxed preload: import only `electron` here (see the note atop preload.ts).

import { contextBridge, ipcRenderer } from 'electron'

// Mirrors CLIENT_CONFIG_CHANNELS in client-config-ipc.ts (that module pulls in node:fs, which a sandboxed
// preload cannot load).
const CHANGED = 'athena:client-config:changed'
const GET = 'athena:client-config:get'
const SNAPSHOT = 'athena:client-config:snapshot'
const DECISION = 'athena:policy-decision'

export function exposeAthenaBridge(): void {
  let snapshot: unknown = null

  try {
    snapshot = ipcRenderer.sendSync(SNAPSHOT) ?? null
  } catch {
    snapshot = null
  }

  contextBridge.exposeInMainWorld('athenaDesktop', {
    clientConfig: {
      snapshot,
      get: () => ipcRenderer.invoke(GET),
      onChanged: (callback: (snapshot: unknown) => void) => {
        const listener = (_event: unknown, next: unknown) => callback(next)
        ipcRenderer.on(CHANGED, listener)

        return () => {
          ipcRenderer.removeListener(CHANGED, listener)
        }
      }
    },
    // A policy decision the renderer made (slices 17 and 19); main stamps and appends it.
    policy: {
      record: (decision: unknown) => ipcRenderer.send(DECISION, decision)
    }
  })
}
