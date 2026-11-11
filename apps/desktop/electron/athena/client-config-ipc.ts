// Athena: hand the verified client config to the renderer (F02 slice 14).
//
// Channels (main ⇄ renderer, all Athena-owned):
// - `athena:client-config:snapshot` (sendSync): the current snapshot, read by
//   preload before the first paint so the first frame is already filtered;
// - `athena:client-config:get` (invoke): the same, on demand;
// - `athena:client-config:changed` (main → every window): each new snapshot;
// - `athena:policy-decision` (renderer → main, send): a decision the renderer
//   made (a JSON-RPC refusal, a report-mode use), appended to the decisions
//   file (policy-decisions.ts) with main's timestamp.
// The tool catalog's source channels (`athena:catalog:*`, catalog-source.ts) are installed here too, so main.ts
// needs no new hook (F03 slice 02).

import path from 'node:path'

import type { BrowserWindow, IpcMain } from 'electron'

import { PRODUCT_IDENTITY } from '../product-identity'

import { installAthenaCatalogSource } from './catalog-source'
import { AthenaClientConfig, type ClientConfigSnapshot, devOverridesFromEnv } from './client-config'
import { applyMainPolicies, configureMainPolicies, ignoredRemoveRows } from './main-policy'
import { parsePolicyDecision, POLICY_DECISIONS_FILE, PolicyDecisionLog } from './policy-decisions'
import { type DesktopVariant, desktopVariant } from './variant'

export const CLIENT_CONFIG_CHANNELS = Object.freeze({
  changed: 'athena:client-config:changed',
  decision: 'athena:policy-decision',
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
  /** Default: from the install stamp and the baked identity (variant.ts). */
  variant?: DesktopVariant
}

/** Remove rows have no flag: a config (server or dev override) that turns one on is ignored, with a log line. */
function warnIgnoredRemoveRows(snapshot: ClientConfigSnapshot, log: (line: string) => void, warned: Set<string>) {
  for (const id of ignoredRemoveRows(snapshot.config)) {
    const key = `${id}:${snapshot.configVersion}:${snapshot.devOverridesActive}`

    if (!warned.has(key)) {
      warned.add(key)
      log(`[athena] features.${id} = "on" ignored: ${id} is removed from the Athena build (a registry change and a build bring it back)`)
    }
  }
}

export function installAthenaClientConfig(options: InstallClientConfigOptions): AthenaClientConfig {
  const devOverrides = devOverridesFromEnv(options.env ?? process.env, options.installStamp)
  const variant = options.variant ?? desktopVariant(options.installStamp, PRODUCT_IDENTITY.appId)
  const warned = new Set<string>()
  const decisions = new PolicyDecisionLog({ file: path.join(options.athenaDir, POLICY_DECISIONS_FILE), log: options.log })
  configureMainPolicies({ decisions, log: options.log })

  if (devOverrides.allowed) {
    options.log(`[athena] dev overrides honoured from ${devOverrides.file} (unmanaged build, ATHENA_DEV_OVERRIDES=1)`)
  }

  const source = new AthenaClientConfig({
    athenaDir: options.athenaDir,
    devOverrides,
    log: options.log,
    variant,
    onChange: snapshot => {
      for (const win of options.allWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(CLIENT_CONFIG_CHANNELS.changed, snapshot)
        }
      }

      warnIgnoredRemoveRows(snapshot, options.log, warned)
      applyMainPolicies(snapshot)
      options.onChange?.(snapshot)
    }
  })

  options.ipcMain.on(CLIENT_CONFIG_CHANNELS.snapshot, event => {
    event.returnValue = source.snapshot()
  })
  options.ipcMain.handle(CLIENT_CONFIG_CHANNELS.get, () => source.snapshot())
  options.ipcMain.on(CLIENT_CONFIG_CHANNELS.decision, (_event, value) => {
    const decision = parsePolicyDecision(value)

    if (decision) {
      decisions.record(decision)
    }
  })
  installAthenaCatalogSource(options.ipcMain, options.log)
  source.start()
  installed = source
  const first = source.snapshot()
  options.log(
    `[athena] client config: ${first.source}${first.configVersion === null ? '' : ` v${first.configVersion}`}` +
      `${first.error ? ` (file ${first.error})` : ''}`
  )

  if (variant === 'stock') {
    options.log('[athena] stock variant: the managed client stays inert (no feature filter, refusals or pins)')
  }

  warnIgnoredRemoveRows(first, options.log, warned)
  applyMainPolicies(first)
  options.onChange?.(first)

  return source
}
