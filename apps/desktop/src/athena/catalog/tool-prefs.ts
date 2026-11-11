/**
 * The user's catalog toggles in the renderer (F02 slice 28).
 *
 * Electron main owns `$HERMES_HOME/athena/tool-prefs.json`: a switch asks it over `window.athenaDesktop.tools`
 * (electron/athena/tool-prefs.ts), and main runs `athena config tool <id> on|off`, which writes the file and
 * re-applies managed scope for new chats. This store only caches what main read back.
 */

import { atom } from 'nanostores'

import type {
  InstalledPackages,
  PackageAction,
  PackageActionResult,
  ToolPrefs,
  ToolToggleResult
} from '../../../electron/athena/tool-prefs-types'

export type { InstalledPackages, PackageAction, PackageActionResult, ToolPrefs, ToolToggleResult }

export interface AthenaToolsBridge {
  getPrefs: () => Promise<unknown>
  set: (id: string, on: boolean) => Promise<unknown>
  /** F03 slices 20-22 (older builds' preload lacks them). */
  getInstalled?: () => Promise<unknown>
  package?: (id: string, action: PackageAction) => Promise<unknown>
}

/** The bridge preload exposes (`window.athenaDesktop.tools`); undefined outside Electron. */
export function toolsBridge(): AthenaToolsBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window as { athenaDesktop?: { tools?: AthenaToolsBridge } }).athenaDesktop?.tools
}

export const $toolPrefs = atom<ToolPrefs>({})

/** `tool-prefs.json` `installed`: the packages this user installed, with version and hash (F03 slice 20). */
export const $installedPackages = atom<InstalledPackages>({})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asPrefs = (value: unknown): ToolPrefs =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean'))
    : {}

export async function loadToolPrefs(bridge: AthenaToolsBridge | undefined = toolsBridge()): Promise<ToolPrefs> {
  if (!bridge) {
    return $toolPrefs.get()
  }

  try {
    $toolPrefs.set(asPrefs(await bridge.getPrefs()))
  } catch {
    // Keep what we had: the page still renders the config's defaults.
  }

  return $toolPrefs.get()
}

/** Ask main to turn one entry on or off for new chats. Never throws: a failure comes back as `ok: false`. */
export async function setToolEnabled(
  id: string,
  on: boolean,
  bridge: AthenaToolsBridge | undefined = toolsBridge()
): Promise<ToolToggleResult> {
  if (!bridge) {
    return { applied: false, enabled: $toolPrefs.get(), message: 'Tool switches need the Athena desktop app.', ok: false }
  }

  try {
    const raw: unknown = await bridge.set(id, on)
    const result = isRecord(raw) ? raw : {}
    const enabled = asPrefs(result.enabled)
    $toolPrefs.set(enabled)

    return {
      applied: result.applied === true,
      enabled,
      message: typeof result.message === 'string' ? result.message : '',
      ok: result.ok === true
    }
  } catch (error) {
    return {
      applied: false,
      enabled: $toolPrefs.get(),
      message: error instanceof Error ? error.message : String(error),
      ok: false
    }
  }
}

const asInstalled = (value: unknown): InstalledPackages =>
  isRecord(value)
    ? (Object.fromEntries(
        Object.entries(value).filter(([, record]) => isRecord(record) && typeof record.version === 'string')
      ) as InstalledPackages)
    : {}

export async function loadInstalledPackages(
  bridge: AthenaToolsBridge | undefined = toolsBridge()
): Promise<InstalledPackages> {
  if (bridge?.getInstalled) {
    try {
      $installedPackages.set(asInstalled(await bridge.getInstalled()))
    } catch {
      // Keep what we had.
    }
  }

  return $installedPackages.get()
}

/** Install, remove or accept one package through main and the CLI. Never throws. */
export async function packageAction(
  id: string,
  action: PackageAction,
  bridge: AthenaToolsBridge | undefined = toolsBridge()
): Promise<PackageActionResult> {
  const failed = (message: string): PackageActionResult => ({
    applied: false,
    enabled: $toolPrefs.get(),
    installed: $installedPackages.get(),
    message,
    ok: false
  })

  if (!bridge?.package) {
    return failed('Installing packages needs the Athena desktop app.')
  }

  try {
    const raw: unknown = await bridge.package(id, action)
    const result = isRecord(raw) ? raw : {}
    $toolPrefs.set(asPrefs(result.enabled))
    $installedPackages.set(asInstalled(result.installed))

    return {
      applied: result.applied === true,
      enabled: $toolPrefs.get(),
      installed: $installedPackages.get(),
      message: typeof result.message === 'string' ? result.message : '',
      ok: result.ok === true
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
