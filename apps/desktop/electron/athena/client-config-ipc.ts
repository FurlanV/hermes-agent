// Athena: hand the verified client config to the renderer (F02 slice 14).
//
// Channels (main ⇄ renderer, all Athena-owned):
// - `athena:client-config:snapshot` (sendSync): the current snapshot, read by
//   preload before the first paint so the first frame is already filtered;
// - `athena:client-config:get` (invoke): the same, on demand;
// - `athena:client-config:changed` (main → every window): each new snapshot.

import type { BrowserWindow, IpcMain } from 'electron'

import { AthenaClientConfig, type ClientConfigSnapshot, devOverridesFromEnv } from './client-config'
import { applyMainPolicies } from './main-policy'

export const CLIENT_CONFIG_CHANNELS = Object.freeze({
  changed: 'athena:client-config:changed',
  get: 'athena:client-config:get',
  snapshot: 'athena:client-config:snapshot'
} as const)

let installed: AthenaClientConfig | null = null

/** The running source (null before `installAthenaClientConfig`, and in tests). */
export function athenaClientConfig(): AthenaClientConfig | null {
  return installed
}

export interface InstallClientConfigOptions {
  allWindows: () => readonly Pick<BrowserWindow, 'isDestroyed' | 'webContents'>[]
  athenaDir: string
  env?: Record<string, string | undefined>
  installStamp: unknown
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  log: (line: string) => void
  /** Each new snapshot, after it is broadcast (main-side policies hook in here). */
  onChange?: (snapshot: ClientConfigSnapshot) => void
}

export function installAthenaClientConfig(options: InstallClientConfigOptions): AthenaClientConfig {
  const devOverrides = devOverridesFromEnv(options.env ?? process.env, options.installStamp)

  if (devOverrides.allowed) {
    options.log(`[athena] dev overrides honoured from ${devOverrides.file} (unmanaged build, ATHENA_DEV_OVERRIDES=1)`)
  }

  const source = new AthenaClientConfig({
    athenaDir: options.athenaDir,
    devOverrides,
    log: options.log,
    onChange: snapshot => {
      for (const win of options.allWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(CLIENT_CONFIG_CHANNELS.changed, snapshot)
        }
      }

      applyMainPolicies(snapshot)
      options.onChange?.(snapshot)
    }
  })

  options.ipcMain.on(CLIENT_CONFIG_CHANNELS.snapshot, event => {
    event.returnValue = source.snapshot()
  })
  options.ipcMain.handle(CLIENT_CONFIG_CHANNELS.get, () => source.snapshot())
  source.start()
  installed = source
  const first = source.snapshot()
  options.log(
    `[athena] client config: ${first.source}${first.configVersion === null ? '' : ` v${first.configVersion}`}` +
      `${first.error ? ` (file ${first.error})` : ''}`
  )
  applyMainPolicies(first)
  options.onChange?.(first)

  return source
}
