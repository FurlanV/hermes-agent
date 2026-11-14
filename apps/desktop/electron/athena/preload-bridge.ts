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
// Mirrors TOOL_PREFS_CHANNELS in tool-prefs.ts (slice 28: the Capabilities page's tool switches).
const TOOL_PREFS_GET = 'athena:tool-prefs:get'
const TOOL_PREFS_SET = 'athena:tool-prefs:set'
const TOOL_PREFS_INSTALLED = 'athena:tool-prefs:installed'
const TOOL_PREFS_PACKAGE = 'athena:tool-prefs:package'
const TOOL_PREFS_ACCESS = 'athena:tool-prefs:access'
const TOOL_PREFS_SETTINGS = 'athena:tool-prefs:settings'
const TOOL_PREFS_SET_SETTINGS = 'athena:tool-prefs:set-settings'
// Mirrors CATALOG_CHANNELS in catalog-source.ts (F03 slice 02: where the tool catalog came from).
const CATALOG_SNAPSHOT = 'athena:catalog:snapshot'
const CATALOG_GET = 'athena:catalog:get'

// Mirrors HPC_BRIDGE_CHANNELS in hpc-bridge-types.ts (F05 slice 06: the HPC bridge's status, connect, disconnect).
const HPC_BRIDGE_STATUS = 'athena:hpc-bridge:status'
const HPC_BRIDGE_CONNECT = 'athena:hpc-bridge:connect'
const HPC_BRIDGE_DISCONNECT = 'athena:hpc-bridge:disconnect'
const HPC_BRIDGE_FORGET_USER = 'athena:hpc-bridge:forget-user'
const HPC_BRIDGE_CHANGED = 'athena:hpc-bridge:changed'

export function exposeAthenaBridge(): void {
  let snapshot: unknown = null

  try {
    snapshot = ipcRenderer.sendSync(SNAPSHOT) ?? null
  } catch {
    snapshot = null
  }

  let catalog: unknown = null

  try {
    catalog = ipcRenderer.sendSync(CATALOG_SNAPSHOT) ?? null
  } catch {
    catalog = null
  }

  contextBridge.exposeInMainWorld('athenaDesktop', {
    catalog: {
      snapshot: catalog,
      get: () => ipcRenderer.invoke(CATALOG_GET)
    },
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
    // F05 slices 06 and 07: the HPC bridge. The calls reject while feature row F05 is off (no handler is
    // registered). `connect` may carry the sign-in dialog's user name and password: handed to main once, kept
    // nowhere here.
    hpcBridge: {
      status: () => ipcRenderer.invoke(HPC_BRIDGE_STATUS),
      connect: (signIn?: { password: string; username: string }) =>
        signIn ? ipcRenderer.invoke(HPC_BRIDGE_CONNECT, signIn) : ipcRenderer.invoke(HPC_BRIDGE_CONNECT),
      disconnect: () => ipcRenderer.invoke(HPC_BRIDGE_DISCONNECT),
      forgetUser: () => ipcRenderer.invoke(HPC_BRIDGE_FORGET_USER),
      onChanged: (callback: (status: unknown) => void) => {
        const listener = (_event: unknown, next: unknown) => callback(next)
        ipcRenderer.on(HPC_BRIDGE_CHANGED, listener)

        return () => {
          ipcRenderer.removeListener(HPC_BRIDGE_CHANGED, listener)
        }
      }
    },
    // A policy decision the renderer made (slices 17 and 19); main stamps and appends it.
    policy: {
      record: (decision: unknown) => ipcRenderer.send(DECISION, decision)
    },
    tools: {
      getPrefs: () => ipcRenderer.invoke(TOOL_PREFS_GET),
      set: (id: string, on: boolean) => ipcRenderer.invoke(TOOL_PREFS_SET, { id, on }),
      // F03 slices 20-22: the installed packages, and install / remove / accept through the CLI.
      getInstalled: () => ipcRenderer.invoke(TOOL_PREFS_INSTALLED),
      package: (id: string, action: string, options?: { reason?: string }) =>
        ipcRenderer.invoke(TOOL_PREFS_PACKAGE, { action, id, reason: options?.reason }),
      // F03 slice 26: what the user holds of each gateway package (package-access.json).
      getAccess: () => ipcRenderer.invoke(TOOL_PREFS_ACCESS),
      // F03 slice 27: the user's package settings, saved through the CLI.
      getSettings: () => ipcRenderer.invoke(TOOL_PREFS_SETTINGS),
      setSettings: (id: string, values: Record<string, unknown>) =>
        ipcRenderer.invoke(TOOL_PREFS_SET_SETTINGS, { id, values })
    }
  })
}
