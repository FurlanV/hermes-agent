// Athena: the Capabilities page's tool switches (F02 slice 28).
//
// The renderer never writes the prefs file or runs anything itself. It asks main over Athena channels:
// - `athena:tool-prefs:get` (invoke): the user's toggles, `$HERMES_HOME/athena/tool-prefs.json` `enabled`;
// - `athena:tool-prefs:set` (invoke, `{id, on}`): runs `athena config tool <id> on|off`, which writes that file and
//   re-applies managed scope (`athena config apply`), so the next new chat gets the change. Open chats keep their
//   tools (hermes builds a session's tool list at `session.create`);
// - `athena:tool-prefs:installed` (invoke): the installed packages, `tool-prefs.json` `installed` (F03 slice 20);
// - `athena:tool-prefs:package` (invoke, `{id, action, reason?}`): runs `athena config tool <id>
//   install|remove|accept|request` (slices 20-22; `request [--reason TEXT]`, slice 26, asks the admins for access).
//   These need the CLI (it records the version and hash from the verified catalog, and holds the user's token):
//   without it they are refused, never written by main;
// - `athena:tool-prefs:access` (invoke): `$HERMES_HOME/athena/package-access.json`, what the user holds of each
//   gateway package as the platform last said (slice 26; the CLI and the shipper write it at each sync);
// - `athena:tool-prefs:settings` (invoke): `tool-prefs.json` `settings`, the user's package settings (slice 27);
// - `athena:tool-prefs:set-settings` (invoke, `{id, values}`): runs `athena config settings <id> --values <json>`
//   (`--clear` for no values), which checks them against the package's schema, writes them and re-applies managed
//   scope. Needs the CLI, like the package actions.
//
// The CLI is found, in order, at `ATHENA_CLI` (the dev launcher passes the monorepo venv's `athena` by absolute
// path), else as `athena` on the PATH the app was launched with, captured when main installs this module (before
// the Desktop merges the login-shell PATH, which can hold another `athena`). With no CLI, main writes the file
// itself, in the CLI's format, and says the change applies after the next config sync (the shipper re-applies
// managed scope after every sync). Locked and unavailable entries are the applier's to ignore either way.

import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

import type { IpcMain } from 'electron'

import type {
  InstalledPackages,
  PackageAccess,
  PackageAction,
  PackageActionResult,
  PackageSettings,
  ScopeAccess,
  SettingsResult,
  SettingValue,
  ToolPrefs,
  ToolToggleResult
} from './tool-prefs-types'

export type {
  InstalledPackages,
  PackageAccess,
  PackageAction,
  PackageActionResult,
  PackageSettings,
  SettingsResult,
  ToolPrefs,
  ToolToggleResult
}

export const TOOL_PREFS_CHANNELS = Object.freeze({
  access: 'athena:tool-prefs:access',
  get: 'athena:tool-prefs:get',
  installed: 'athena:tool-prefs:installed',
  package: 'athena:tool-prefs:package',
  set: 'athena:tool-prefs:set',
  setSettings: 'athena:tool-prefs:set-settings',
  settings: 'athena:tool-prefs:settings'
} as const)

const PACKAGE_ACTIONS: ReadonlySet<string> = new Set(['accept', 'install', 'remove', 'request'])

export const TOOL_PREFS_FILE = 'tool-prefs.json'
export const ACCESS_FILE = 'package-access.json'
const MAX_REASON = 500
const SCOPE_ACCESS: ReadonlySet<string> = new Set(['granted', 'none', 'requested'])
const SETTING_ID = /^[a-z][a-z0-9_]{0,63}$/
const MAX_SETTINGS = 16
const MAX_TEXT_SETTING = 200

const isSettingValue = (value: unknown): value is SettingValue =>
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= MAX_TEXT_SETTING)

/** `tool-prefs.json`'s `settings` (slice 27): well-formed values per package only; anything unreadable is none. */
export function readPackageSettings(file: string): PackageSettings {
  let data: unknown

  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }

  const section = isRecord(data) && isRecord(data.settings) ? data.settings : {}

  return Object.fromEntries(
    Object.entries(section)
      .filter((pair): pair is [string, Record<string, unknown>] => ENTRY_ID.test(pair[0]) && isRecord(pair[1]))
      .map(([id, values]) => [
        id,
        Object.fromEntries(
          Object.entries(values).filter((pair): pair is [string, SettingValue] => SETTING_ID.test(pair[0]) && isSettingValue(pair[1]))
        )
      ])
  )
}

/** The values the renderer sent, as the CLI's `--values` JSON, or null for anything that is not a small flat map. */
export function settingsArgument(values: unknown): null | string {
  if (!isRecord(values)) {
    return null
  }

  const entries = Object.entries(values)

  if (entries.length > MAX_SETTINGS || !entries.every(([key, value]) => SETTING_ID.test(key) && isSettingValue(value))) {
    return null
  }

  return JSON.stringify(Object.fromEntries(entries))
}

/** A catalog id (athena_schemas `ToolId`); anything else never reaches the CLI's argv. */
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const CLI_TIMEOUT_MS = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** `tool-prefs.json`'s `enabled` map; anything unreadable counts as no toggles (as the applier reads it). */
export function readToolPrefs(file: string): ToolPrefs {
  let data: unknown

  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }

  const enabled = isRecord(data) ? data.enabled : undefined

  if (!isRecord(enabled)) {
    return {}
  }

  return Object.fromEntries(Object.entries(enabled).filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean'))
}

/** `tool-prefs.json`'s `installed` records (anything unreadable: none). */
export function readInstalledPackages(file: string): InstalledPackages {
  let data: unknown

  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }

  const installed = isRecord(data) ? data.installed : undefined

  if (!isRecord(installed)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(installed).filter(
      (pair): pair is [string, InstalledPackages[string]] => isRecord(pair[1]) && typeof pair[1].version === 'string'
    )
  )
}

/** `package-access.json` (slice 26): only well-formed packages and scopes; anything unreadable is `{packages: {}}`. */
export function readPackageAccess(file: string): PackageAccess {
  let data: unknown

  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { packages: {} }
  }

  const packages = isRecord(data) && isRecord(data.packages) ? data.packages : {}
  const out: PackageAccess['packages'] = {}

  for (const [id, value] of Object.entries(packages)) {
    if (!ENTRY_ID.test(id) || !isRecord(value) || !isRecord(value.scopes)) {
      continue
    }

    const scopes = Object.fromEntries(
      Object.entries(value.scopes).filter((pair): pair is [string, ScopeAccess] => SCOPE_ACCESS.has(String(pair[1])))
    )

    out[id] = { scopes, state: value.state === 'suspended' ? 'suspended' : 'active' }
  }

  return { fetched_at: isRecord(data) && typeof data.fetched_at === 'string' ? data.fetched_at : undefined, packages: out }
}

/** A request's reason as one line for the CLI's argv: trimmed, control characters dropped, at most 500 characters. */
export function requestReason(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_REASON)

  return text || null
}

/** Set one toggle, keeping the others and any other keys: the CLI's format (sorted, 2-space JSON, 0600, atomic). */
export function writeToolPref(file: string, id: string, on: boolean): ToolPrefs {
  let data: Record<string, unknown> = {}

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    data = isRecord(parsed) ? parsed : {}
  } catch {
    data = {}
  }

  const enabled = { ...readToolPrefs(file), [id]: on }

  const sorted = (record: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))

  const text = `${JSON.stringify(sorted({ ...data, enabled: sorted(enabled) }), null, 2)}\n`

  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`)
  rmSync(tmp, { force: true })
  const fd = openSync(tmp, 'wx', 0o600)

  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }

  renameSync(tmp, file)

  return enabled
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)

    return true
  } catch {
    return false
  }
}

/** The athena CLI: `ATHENA_CLI` when it is an executable absolute path, else `athena` on `launchPath`, else null. */
export function resolveAthenaCli(
  env: Record<string, string | undefined>,
  launchPath: string | undefined,
  isExecutable: (file: string) => boolean = executable
): string | null {
  const explicit = env.ATHENA_CLI?.trim()

  if (explicit && path.isAbsolute(explicit) && isExecutable(explicit)) {
    return explicit
  }

  for (const dir of (launchPath ?? '').split(path.delimiter)) {
    // Relative PATH entries would resolve against main's cwd: never.
    if (dir && path.isAbsolute(dir)) {
      const candidate = path.join(dir, 'athena')

      if (isExecutable(candidate)) {
        return candidate
      }
    }
  }

  return null
}

export interface CliResult {
  code: number
  stderr: string
  stdout: string
}

export type RunCli = (file: string, args: string[], env: Record<string, string | undefined>) => Promise<CliResult>

const runCli: RunCli = (file, args, env) =>
  new Promise(resolve => {
    execFile(file, args, { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stderr: String(stderr ?? '') || (error && code !== 0 ? error.message : ''), stdout: String(stdout ?? '') })
    })
  })

const firstLine = (text: string) =>
  text
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? ''

export interface ToolPrefsOptions {
  /** The Profile's `$HERMES_HOME` (the CLI gets it as `HERMES_HOME`). */
  hermesHome: string
  env?: Record<string, string | undefined>
  /** The PATH the app was launched with (default: `env.PATH` now, i.e. at install). */
  launchPath?: string
  log: (line: string) => void
  run?: RunCli
  isExecutable?: (file: string) => boolean
}

export class AthenaToolPrefs {
  readonly file: string
  private readonly env: Record<string, string | undefined>
  private readonly launchPath: string | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ToolPrefsOptions) {
    this.env = options.env ?? process.env
    this.launchPath = options.launchPath ?? this.env.PATH
    this.file = path.join(options.hermesHome, 'athena', TOOL_PREFS_FILE)
  }

  prefs(): ToolPrefs {
    return readToolPrefs(this.file)
  }

  installed(): InstalledPackages {
    return readInstalledPackages(this.file)
  }

  access(): PackageAccess {
    return readPackageAccess(path.join(path.dirname(this.file), ACCESS_FILE))
  }

  /** Install, remove, accept or request one package through the CLI, queued with the toggles. */
  package(id: unknown, action: unknown, reason?: unknown): Promise<PackageActionResult> {
    const next = this.queue.then(() => this.packageNow(id, action, reason))
    this.queue = next.catch(() => undefined)

    return next
  }

  private async packageNow(id: unknown, action: unknown, reason?: unknown): Promise<PackageActionResult> {
    // Slice 26: a request also answers with the access file (the other actions' answers are as before).
    const withAccess = (result: PackageActionResult): PackageActionResult =>
      action === 'request' ? { ...result, access: this.access() } : result

    const refused = (message: string): PackageActionResult =>
      withAccess({ applied: false, enabled: this.prefs(), installed: this.installed(), message, ok: false })

    if (typeof id !== 'string' || !ENTRY_ID.test(id) || typeof action !== 'string' || !PACKAGE_ACTIONS.has(action)) {
      return refused('Not a catalog package.')
    }

    const cli = this.cli()

    if (!cli) {
      this.options.log(`[athena] package ${id} ${action}: no athena CLI (ATHENA_CLI or PATH); refused`)

      return refused('Installing needs the Athena command-line tool, which this app cannot find.')
    }

    const why = action === 'request' ? requestReason(reason) : null
    const args = ['config', 'tool', id, action, ...(why ? ['--reason', why] : [])]
    const result = await (this.options.run ?? runCli)(cli, args, this.cliEnv())
    const message = firstLine(result.code === 0 ? result.stdout : result.stderr || result.stdout)
    this.options.log(`[athena] ${cli} config tool ${id} ${action}: exit ${result.code}${message ? ` (${message})` : ''}`)

    if (result.code !== 0) {
      return refused(message || `athena exited ${result.code}`)
    }

    return withAccess({ applied: true, enabled: this.prefs(), installed: this.installed(), message, ok: true })
  }

  private cliEnv(): Record<string, string | undefined> {
    // The CLI's own venv, not whatever Python main's environment points at.
    const env: Record<string, string | undefined> = { ...this.env, HERMES_HOME: this.options.hermesHome }
    delete env.PYTHONHOME
    delete env.PYTHONPATH
    delete env.VIRTUAL_ENV

    return env
  }

  cli(): string | null {
    return resolveAthenaCli(this.env, this.launchPath, this.options.isExecutable)
  }

  /**
   * Re-apply managed scope now (`athena config apply`), queued with the toggles so two CLI runs never write it at
   * once. The HPC bridge asks for it after its bridge record changed (F05 slice 06). Without a CLI nothing runs:
   * the Shipper's own apply follows within its sync interval.
   */
  applyConfig(): Promise<boolean> {
    const next = this.queue.then(async () => {
      const cli = this.cli()

      if (!cli) {
        this.options.log('[athena] config apply: no athena CLI (ATHENA_CLI or PATH); the next sync applies it')

        return false
      }

      const result = await (this.options.run ?? runCli)(cli, ['config', 'apply'], this.cliEnv())
      const message = firstLine(result.code === 0 ? result.stdout : result.stderr || result.stdout)
      this.options.log(`[athena] ${cli} config apply: exit ${result.code}${message ? ` (${message})` : ''}`)

      return result.code === 0
    })

    this.queue = next.catch(() => undefined)

    return next
  }

  settings(): PackageSettings {
    return readPackageSettings(this.file)
  }

  /** Save one package's settings through the CLI (it checks them against the package's schema), queued. */
  setSettings(id: unknown, values: unknown): Promise<SettingsResult> {
    const next = this.queue.then(() => this.setSettingsNow(id, values))
    this.queue = next.catch(() => undefined)

    return next
  }

  private async setSettingsNow(id: unknown, values: unknown): Promise<SettingsResult> {
    const refused = (message: string): SettingsResult => ({ applied: false, message, ok: false, settings: this.settings() })
    const json = settingsArgument(values)

    if (typeof id !== 'string' || !ENTRY_ID.test(id) || json === null) {
      return refused('Not a package setting.')
    }

    const cli = this.cli()

    if (!cli) {
      this.options.log(`[athena] settings of ${id}: no athena CLI (ATHENA_CLI or PATH); refused`)

      return refused('Saving settings needs the Athena command-line tool, which this app cannot find.')
    }

    const args = json === '{}' ? ['config', 'settings', id, '--clear'] : ['config', 'settings', id, '--values', json]
    const result = await (this.options.run ?? runCli)(cli, args, this.cliEnv())
    const message = firstLine(result.code === 0 ? result.stdout : result.stderr || result.stdout)
    this.options.log(`[athena] ${cli} config settings ${id}: exit ${result.code}${message ? ` (${message})` : ''}`)

    if (result.code !== 0) {
      return refused(message || `athena exited ${result.code}`)
    }

    return { applied: true, message, ok: true, settings: this.settings() }
  }

  /** One toggle at a time: each runs the CLI (write + apply) after the previous one finished. */
  set(id: unknown, on: unknown): Promise<ToolToggleResult> {
    const next = this.queue.then(() => this.setNow(id, on))
    this.queue = next.catch(() => undefined)

    return next
  }

  private async setNow(id: unknown, on: unknown): Promise<ToolToggleResult> {
    if (typeof id !== 'string' || !ENTRY_ID.test(id) || typeof on !== 'boolean') {
      return { ok: false, applied: false, enabled: this.prefs(), message: 'Not a catalog tool.' }
    }

    const state = on ? 'on' : 'off'
    const cli = this.cli()

    if (!cli) {
      writeToolPref(this.file, id, on)
      this.options.log(`[athena] tool ${id} ${state}: no athena CLI (ATHENA_CLI or PATH); wrote ${this.file} only`)

      return {
        ok: true,
        applied: false,
        enabled: this.prefs(),
        message: 'Saved. It applies to new chats after the next config sync.'
      }
    }

    const result = await (this.options.run ?? runCli)(cli, ['config', 'tool', id, state], this.cliEnv())
    const message = firstLine(result.code === 0 ? result.stdout : result.stderr || result.stdout)
    this.options.log(`[athena] ${cli} config tool ${id} ${state}: exit ${result.code}${message ? ` (${message})` : ''}`)

    if (result.code !== 0) {
      return { ok: false, applied: false, enabled: this.prefs(), message: message || `athena exited ${result.code}` }
    }

    return { ok: true, applied: true, enabled: this.prefs(), message: message || 'Applies to new chats.' }
  }
}

export interface InstallToolPrefsOptions extends ToolPrefsOptions {
  ipcMain: Pick<IpcMain, 'handle'>
}

export function installAthenaToolPrefs(options: InstallToolPrefsOptions): AthenaToolPrefs {
  const prefs = new AthenaToolPrefs(options)
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.get, () => prefs.prefs())
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.set, (_event, request: unknown) => {
    const { id, on } = isRecord(request) ? request : {}

    return prefs.set(id, on)
  })
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.installed, () => prefs.installed())
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.package, (_event, request: unknown) => {
    const { action, id, reason } = isRecord(request) ? request : {}

    return prefs.package(id, action, reason)
  })
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.access, () => prefs.access())
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.settings, () => prefs.settings())
  options.ipcMain.handle(TOOL_PREFS_CHANNELS.setSettings, (_event, request: unknown) => {
    const { id, values } = isRecord(request) ? request : {}

    return prefs.setSettings(id, values)
  })
  const cli = prefs.cli()
  options.log(`[athena] tool prefs: ${prefs.file}; athena CLI ${cli ?? 'not found (toggles write the file only)'}`)

  return prefs
}
