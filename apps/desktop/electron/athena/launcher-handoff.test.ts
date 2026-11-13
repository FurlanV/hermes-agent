// R01 slice 26: a Desktop binary opened directly from an install root hands the launch to the launcher.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { type HandoffInputs, handoffPlan, installRootOf, launchedByLauncher } from './launcher-handoff'

const MAC_ROOT = '/Users/ada/Library/Application Support/Athena'
const WIN_ROOT = 'C:\\Users\\ada\\AppData\\Local\\Athena'

const files = (...paths: string[]): ((file: string) => boolean) => {
  const known = new Set(paths)

  return file => known.has(file)
}

const mac = (overrides: Partial<HandoffInputs> = {}): HandoffInputs => ({
  env: { HOME: '/Users/ada', OPENAI_API_KEY: 'sk-x', USER: 'ada' },
  execPath: `${MAC_ROOT}/app.noindex/Athena.app/Contents/MacOS/Athena`,
  isFile: files(`${MAC_ROOT}/settings.json`, `${MAC_ROOT}/share/athena-desktop.sh`),
  platform: 'darwin',
  ...overrides
})

const win = (overrides: Partial<HandoffInputs> = {}): HandoffInputs => ({
  env: { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local', SystemRoot: 'C:\\Windows' },
  execPath: `${WIN_ROOT}\\app\\Athena\\Athena.exe`,
  isFile: files(`${WIN_ROOT}\\settings.json`, `${WIN_ROOT}\\share\\athena-desktop.ps1`),
  platform: 'win32',
  ...overrides
})

const LAUNCHER_ENV = { HERMES_DESKTOP_USER_DATA_DIR: `${MAC_ROOT}/desktop/user-data`, HERMES_HOME: `${MAC_ROOT}/profile` }

describe('the install root of a Desktop binary', () => {
  test('macOS: the bundle under app.noindex, or under the app link the launcher uses', () => {
    expect(installRootOf(mac())).toBe(MAC_ROOT)
    expect(installRootOf(mac({ execPath: `${MAC_ROOT}/app/Athena.app/Contents/MacOS/Athena` }))).toBe(MAC_ROOT)
  })

  test('Windows: Athena.exe under app', () => {
    expect(installRootOf(win())).toBe(WIN_ROOT)
  })

  test('a dev bundle, a stock install and an app folder with no settings.json are in no install root', () => {
    const none = files()

    expect(installRootOf(mac({ execPath: '/src/hermes/apps/desktop/release/mac-arm64/Athena.app/Contents/MacOS/Athena' }))).toBeNull()
    expect(installRootOf(mac({ execPath: '/Applications/Hermes.app/Contents/MacOS/Hermes' }))).toBeNull()
    expect(installRootOf(mac({ isFile: none }))).toBeNull()
    expect(installRootOf(win({ isFile: none }))).toBeNull()
  })
})

describe('a direct launch of the Desktop binary', () => {
  test('macOS: starts the launcher on the install root with a clean environment, logging where the icon does', () => {
    const plan = handoffPlan(mac())

    expect(plan).toEqual({
      kind: 'handoff',
      launcher: `${MAC_ROOT}/share/athena-desktop.sh`,
      root: MAC_ROOT,
      run: {
        args: [`${MAC_ROOT}/share/athena-desktop.sh`],
        command: '/bin/bash',
        env: { ATHENA_INSTALL_ROOT: MAC_ROOT, HOME: '/Users/ada', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: 'ada' },
        logFile: `${MAC_ROOT}/logs/desktop.log`,
        noteFile: `${MAC_ROOT}/logs/athena-icon.log`,
        pidFile: `${MAC_ROOT}/desktop/launcher.pid`
      }
    })
  })

  test('Windows: runs the launcher with the Start Menu shortcut command and the install root', () => {
    const plan = handoffPlan(win())

    expect(plan.kind).toBe('handoff')

    if (plan.kind === 'handoff') {
      expect(plan.run.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(plan.run.args).toEqual([
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        `${WIN_ROOT}\\share\\athena-desktop.ps1`
      ])
      expect(plan.run.env.ATHENA_INSTALL_ROOT).toBe(WIN_ROOT)
      expect(plan.run.env.LOCALAPPDATA).toBe('C:\\Users\\ada\\AppData\\Local')
    }
  })

  test('a launch by the launcher is never handed off again', () => {
    expect(launchedByLauncher(LAUNCHER_ENV)).toBe(true)
    expect(launchedByLauncher({ HERMES_HOME: `${MAC_ROOT}/profile` })).toBe(false)
    expect(handoffPlan(mac({ env: LAUNCHER_ENV }))).toEqual({ kind: 'none' })
    expect(handoffPlan(win({ env: { ...LAUNCHER_ENV, SystemRoot: 'C:\\Windows' } }))).toEqual({ kind: 'none' })
  })

  test('an install root without its launcher: say so, never run unmanaged', () => {
    expect(handoffPlan(mac({ isFile: files(`${MAC_ROOT}/settings.json`) }))).toEqual({
      kind: 'launcher-missing',
      launcher: `${MAC_ROOT}/share/athena-desktop.sh`,
      root: MAC_ROOT
    })
  })

  test('outside an install root (a dev run, a stock build) and on other systems nothing changes', () => {
    expect(handoffPlan(mac({ execPath: '/src/hermes/apps/desktop/release/mac-arm64/Athena.app/Contents/MacOS/Athena' }))).toEqual({
      kind: 'none'
    })
    expect(handoffPlan(mac({ platform: 'linux' }))).toEqual({ kind: 'none' })
  })
})

describe('main.ts', () => {
  test('runs the hand-off before anything else: the first import of its first import', () => {
    const firstImport = (file: string) =>
      readFileSync(path.resolve(import.meta.dirname, file), 'utf8')
        .split('\n')
        .find(line => line.startsWith('import '))

    expect(firstImport('../main.ts')).toBe("import './athena/ipc-guard-install'")
    expect(firstImport('ipc-guard-install.ts')).toBe("import './launcher-handoff-install'")
  })
})
