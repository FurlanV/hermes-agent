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
  PackageAccess,
  PackageAction,
  PackageActionOptions,
  PackageActionResult,
  PackageSettings,
  SettingsResult,
  SettingValue,
  ToolPrefs,
  ToolToggleResult
} from '../../../electron/athena/tool-prefs-types'

export type {
  InstalledPackages,
  PackageAccess,
  PackageAction,
  PackageActionResult,
  PackageSettings,
  SettingsResult,
  SettingValue,
  ToolPrefs,
  ToolToggleResult
}

export interface AthenaToolsBridge {
  getPrefs: () => Promise<unknown>
  set: (id: string, on: boolean) => Promise<unknown>
  /** F03 slices 20-22 (older builds' preload lacks them). */
  getInstalled?: () => Promise<unknown>
  package?: (id: string, action: PackageAction, options?: PackageActionOptions) => Promise<unknown>
  /** F03 slice 26. */
  getAccess?: () => Promise<unknown>
  /** F03 slice 27. */
  getSettings?: () => Promise<unknown>
  setSettings?: (id: string, values: Record<string, SettingValue>) => Promise<unknown>
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

/**
 * `package-access.json`: what the user holds of each gateway package, as the platform last said (F03 slice 26).
 * `null` until main answered (or without a main that knows it): the page then shows no access state at all.
 */
export const $packageAccess = atom<null | PackageAccess>(null)

/** `tool-prefs.json` `settings`: the user's values per package (F03 slice 27). */
export const $packageSettings = atom<PackageSettings>({})

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

const asAccess = (value: unknown): null | PackageAccess =>
  isRecord(value) && isRecord(value.packages) ? (value as unknown as PackageAccess) : null

export async function loadPackageAccess(
  bridge: AthenaToolsBridge | undefined = toolsBridge()
): Promise<null | PackageAccess> {
  if (bridge?.getAccess) {
    try {
      $packageAccess.set(asAccess(await bridge.getAccess()))
    } catch {
      // Keep what we had.
    }
  }

  return $packageAccess.get()
}

/** Install, remove, accept or request one package through main and the CLI. Never throws. */
export async function packageAction(
  id: string,
  action: PackageAction,
  bridge: AthenaToolsBridge | undefined = toolsBridge(),
  options?: PackageActionOptions
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
    const raw: unknown = await (options ? bridge.package(id, action, options) : bridge.package(id, action))
    const result = isRecord(raw) ? raw : {}
    $toolPrefs.set(asPrefs(result.enabled))
    $installedPackages.set(asInstalled(result.installed))

    if (asAccess(result.access)) {
      $packageAccess.set(asAccess(result.access))
    }

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

const asSettings = (value: unknown): PackageSettings =>
  isRecord(value)
    ? (Object.fromEntries(Object.entries(value).filter(([, values]) => isRecord(values))) as PackageSettings)
    : {}

export async function loadPackageSettings(bridge: AthenaToolsBridge | undefined = toolsBridge()): Promise<PackageSettings> {
  if (bridge?.getSettings) {
    try {
      $packageSettings.set(asSettings(await bridge.getSettings()))
    } catch {
      // Keep what we had.
    }
  }

  return $packageSettings.get()
}

/** Save one package's settings through main and the CLI (which checks them again). Never throws. */
export async function savePackageSettings(
  id: string,
  values: Record<string, SettingValue>,
  bridge: AthenaToolsBridge | undefined = toolsBridge()
): Promise<SettingsResult> {
  if (!bridge?.setSettings) {
    return { applied: false, message: 'Package settings need the Athena desktop app.', ok: false, settings: $packageSettings.get() }
  }

  try {
    const raw: unknown = await bridge.setSettings(id, values)
    const result = isRecord(raw) ? raw : {}
    $packageSettings.set(asSettings(result.settings))

    return {
      applied: result.applied === true,
      message: typeof result.message === 'string' ? result.message : '',
      ok: result.ok === true,
      settings: $packageSettings.get()
    }
  } catch (error) {
    return {
      applied: false,
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      settings: $packageSettings.get()
    }
  }
}
