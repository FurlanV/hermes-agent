// R02 slice 04: the Athena build refuses the upstream setup. The start path below is upstream's own
// (`runPrimaryBackendStartup`, then `runBootstrap`), hooked the way main.ts hooks it, with every way out of the
// process (http, https, sockets, DNS, fetch, child processes) replaced by a trap that records the call and throws.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const outside = vi.hoisted(() => {
  const calls: string[] = []

  const trap =
    (name: string) =>
    (...args: unknown[]): never => {
      const target = args.find(arg => typeof arg === 'string' || arg instanceof URL)
      calls.push(`${name} ${String(target ?? '')}`.trim())

      throw new Error(`${name} is not allowed in this test`)
    }

  const trapped = <T extends object>(module: T, label: string, names: readonly string[]): T => {
    const traps = Object.fromEntries(names.map(name => [name, trap(`${label}.${name}`)]))

    return { ...module, ...traps, default: { ...module, ...traps } }
  }

  return { calls, trap, trapped }
})

vi.mock('node:https', async original => outside.trapped(await original<object>(), 'https', ['get', 'request']))
vi.mock('node:http', async original => outside.trapped(await original<object>(), 'http', ['get', 'request']))
vi.mock('node:net', async original =>
  outside.trapped(await original<object>(), 'net', ['connect', 'createConnection'])
)
vi.mock('node:tls', async original => outside.trapped(await original<object>(), 'tls', ['connect']))
vi.mock('node:dns', async original => outside.trapped(await original<object>(), 'dns', ['lookup', 'resolve']))
vi.mock('node:child_process', async original =>
  outside.trapped(await original<object>(), 'child_process', [
    'exec',
    'execFile',
    'execFileSync',
    'execSync',
    'fork',
    'spawn',
    'spawnSync'
  ])
)

import { runBootstrap } from '../bootstrap-runner'
import { runPrimaryBackendStartup } from '../primary-backend-startup'

import {
  ATHENA_NOT_INSTALLED,
  createUpstreamSetupGate,
  UPSTREAM_SETUP_FEATURE,
  type UpstreamSetupGate,
  upstreamSetupRefused,
  UpstreamSetupRefusedError
} from './upstream-setup'
import { ATHENA_APP_ID } from './variant'

const ATHENA_STAMP = { branch: 'release/0.1.0-friends.6', brand: 'athena', commit: 'a'.repeat(40) }
const STOCK_STAMP = { branch: 'main', commit: 'a'.repeat(40) }
const BOOTSTRAP_NEEDED = { bootstrap: true, kind: 'bootstrap-needed' as const }

const home = mkdtempSync(path.join(tmpdir(), 'athena-upstream-setup-'))

afterAll(() => rmSync(home, { force: true, recursive: true }))

beforeEach(() => {
  outside.calls.length = 0
  vi.stubGlobal('fetch', outside.trap('fetch'))
})

afterEach(() => vi.unstubAllGlobals())

function harness(installStamp: unknown, config: unknown = {}, appId?: string) {
  const seen = { dialogs: [] as { message: string; type?: string }[], exits: [] as number[], order: [] as string[] }

  const gate = createUpstreamSetupGate({
    app: { exit: code => void (seen.exits.push(code ?? 0), seen.order.push('exit')) },
    appId,
    config: () => config,
    dialog: { showMessageBoxSync: (options: { message: string; type?: string }) => (seen.dialogs.push(options), seen.order.push('dialog'), 0) } as never,
    flushLog: () => void seen.order.push('flush'),
    installStamp,
    log: line => void seen.order.push(`log ${line}`)
  })

  return { gate, seen }
}

/** The start as main.ts runs it: resolve (no hermes), the first-run choice, then the installer. */
async function start(gate: UpstreamSetupGate, installStamp: unknown) {
  const reached = { bootstrap: false, choice: false }

  const result = runPrimaryBackendStartup({
    assertCurrentAttempt: () => {},
    connectRemote: async () => null,
    ensureLocalRuntime: async (backend: typeof BOOTSTRAP_NEEDED) => {
      gate.exitIfRefused('the upstream installer was about to start')
      reached.bootstrap = true

      return runBootstrap({
        abortSignal: new AbortController().signal,
        activeRoot: path.join(home, 'hermes-agent'),
        gitBinary: 'git',
        hermesHome: home,
        installStamp,
        logRoot: path.join(home, 'logs'),
        onEvent: () => {},
        sourceRepoRoot: null,
        writeMarker: () => {},
        ...backend
      })
    },
    prepareLocalBackend: async () => gate.resolved(BOOTSTRAP_NEEDED),
    resolveRemote: async () => null,
    waitForDecision: async () => {
      reached.choice = true

      return 'continue-local' as const
    },
    waitForLocalStart: async () => {}
  })

  const error: unknown = await result.then(
    () => null,
    reason => reason
  )

  return { error, reached }
}

describe('whether the upstream setup is refused', () => {
  test('the Athena build refuses it by default; a stock build never does', () => {
    expect(upstreamSetupRefused('athena', {})).toBe(true)
    expect(upstreamSetupRefused('athena', undefined)).toBe(true)
    expect(upstreamSetupRefused('stock', {})).toBe(false)
  })

  test('only the row itself switches it on: the master switch does not', () => {
    expect(upstreamSetupRefused('athena', { features: { [UPSTREAM_SETUP_FEATURE]: 'on' } })).toBe(false)
    expect(upstreamSetupRefused('athena', { managed: { features: 'off' } })).toBe(true)
    expect(upstreamSetupRefused('athena', { managed: { features: 'report' } })).toBe(true)
  })
})

describe('an Athena Desktop that finds no hermes', () => {
  test('shows one dialog and exits, and nothing leaves the process', async () => {
    const { gate, seen } = harness(ATHENA_STAMP)
    const { error, reached } = await start(gate, ATHENA_STAMP)

    expect(seen.dialogs).toEqual([
      { buttons: ['OK'], message: 'Athena is not installed on this computer. Run Athena Setup.', noLink: true, type: 'error' }
    ])
    expect(seen.exits).toEqual([1])
    expect(error).toBeInstanceOf(UpstreamSetupRefusedError)
    expect(reached).toEqual({ bootstrap: false, choice: false })
    expect(outside.calls).toEqual([])
  })

  test('writes the reason to the log before the dialog blocks, then exits', () => {
    const { gate, seen } = harness(ATHENA_STAMP)

    expect(() => gate.resolved(BOOTSTRAP_NEEDED)).toThrow(ATHENA_NOT_INSTALLED)
    expect(seen.order).toEqual([
      'log [athena] upstream setup refused (no hermes found at startup; feature R02 is off); exiting',
      'flush',
      'dialog',
      'exit'
    ])
  })

  test('an unstamped Athena dev bundle is refused too, by its app id', async () => {
    const { gate, seen } = harness(null, {}, ATHENA_APP_ID)

    await start(gate, null)

    expect(seen.exits).toEqual([1])
    expect(outside.calls).toEqual([])
  })

  test('a path that reaches the installer without the startup check is stopped there', async () => {
    const { gate, seen } = harness(ATHENA_STAMP)

    expect(() => gate.exitIfRefused('the upstream installer was about to start')).toThrow(UpstreamSetupRefusedError)
    expect(seen.dialogs).toHaveLength(1)
    expect(seen.exits).toEqual([1])
  })
})

describe('a start that found a hermes', () => {
  test('goes on with the backend it resolved', () => {
    const { gate, seen } = harness(ATHENA_STAMP)
    const backend = { command: '/opt/athena/bin/hermes', kind: 'source' }

    expect(gate.resolved(backend)).toBe(backend)
    expect(seen.order).toEqual([])
  })
})

describe('"Repair install"', () => {
  test('in the Athena build answers the same message and leaves the app open', () => {
    const { gate, seen } = harness(ATHENA_STAMP)

    expect(gate.repairRefusal()).toEqual({
      error: 'Athena is not installed on this computer. Run Athena Setup.',
      ok: false
    })
    expect(seen.exits).toEqual([])
    expect(seen.dialogs).toEqual([])
  })

  test('is not refused with the row on, or in a stock build', () => {
    expect(harness(ATHENA_STAMP, { features: { R02: 'on' } }).gate.repairRefusal()).toBeNull()
    expect(harness(STOCK_STAMP).gate.repairRefusal()).toBeNull()
  })
})

describe('the upstream setup still starts', () => {
  const startsUpstreamSetup = async (installStamp: { branch: string; commit: string }, config: unknown) => {
    const { gate, seen } = harness(installStamp, config)
    const { reached } = await start(gate, installStamp)

    expect(seen.dialogs).toEqual([])
    expect(seen.exits).toEqual([])
    expect(reached).toEqual({ bootstrap: true, choice: true })
    // Upstream's first step: the install script, from GitHub.
    expect(outside.calls.filter(call => call.startsWith('https.get'))).toEqual([
      expect.stringMatching(
        new RegExp(`^https\\.get https://raw\\.githubusercontent\\.com/NousResearch/hermes-agent/${installStamp.commit}/scripts/install\\.(sh|ps1)$`)
      )
    ])
  }

  test('with the row switched on in the Athena build', () =>
    startsUpstreamSetup(ATHENA_STAMP, { features: { R02: 'on' } }))

  test('in a stock build, whatever the config says', () => startsUpstreamSetup(STOCK_STAMP, {}))
})

describe('main.ts asks the gate', () => {
  const main = readFileSync(path.join(import.meta.dirname, '../main.ts'), 'utf8')

  /** The text of main.ts from `from` up to the next `until`. */
  const between = (from: string, until: string) => {
    const start = main.indexOf(from)
    const end = main.indexOf(until, start)

    expect(start, from).toBeGreaterThan(-1)
    expect(end, until).toBeGreaterThan(start)

    return main.slice(start, end)
  }

  test('at startup, before the first-run choice', () => {
    expect(between('prepareLocalBackend: async () => {', 'resolveRemote: () => {')).toContain(
      'return athenaUpstreamSetup.resolved(await resolveHermesBackend(backendArgs))'
    )
  })

  test('in ensureRuntime, before the Windows recovery hand-off and the installer', () => {
    const runtime = between('async function ensureRuntime(', 'await runBootstrap(')

    expect(runtime).toContain('athenaUpstreamSetup.exitIfRefused(')
    expect(runtime.indexOf('athenaUpstreamSetup.exitIfRefused(')).toBeLessThan(
      runtime.indexOf("handOffWindowsBootstrapRecovery('bootstrap-needed')")
    )
  })

  test('in the repair channel, before anything is torn down', () => {
    const repair = between("ipcMain.handle('hermes:bootstrap:repair'", 'bootstrapRepairAttempt += 1')

    expect(repair).toContain('athenaUpstreamSetup.repairRefusal()')
  })
})
