// F03 slice 26: main reads package-access.json for the Capabilities page and runs `athena config tool <id> request
// [--reason TEXT]`; the reason reaches the CLI's argv as one bounded line.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  AthenaToolPrefs,
  installAthenaToolPrefs,
  readPackageAccess,
  requestReason,
  type RunCli,
  TOOL_PREFS_CHANNELS
} from './tool-prefs'

let home: string
let accessFile: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-access-'))
  accessFile = path.join(home, 'athena', 'package-access.json')
  mkdirSync(path.dirname(accessFile), { recursive: true })
})

afterEach(() => rmSync(home, { force: true, recursive: true }))

describe('package-access.json', () => {
  test('keeps well-formed packages and scope states only; anything unreadable is no packages', () => {
    expect(readPackageAccess(accessFile)).toEqual({ packages: {} })
    writeFileSync(
      accessFile,
      JSON.stringify({
        fetched_at: '2026-11-11T10:00:00+00:00',
        packages: {
          'BAD ID': { scopes: { a: 'granted' } },
          'no-scopes': { state: 'active' },
          'stub-echo': { scopes: { 'echo.basic': 'granted', 'echo.reverse': 'maybe' }, state: 'suspended' }
        }
      })
    )
    expect(readPackageAccess(accessFile)).toEqual({
      fetched_at: '2026-11-11T10:00:00+00:00',
      packages: { 'stub-echo': { scopes: { 'echo.basic': 'granted' }, state: 'suspended' } }
    })
    writeFileSync(accessFile, 'not json')
    expect(readPackageAccess(accessFile)).toEqual({ packages: {} })
  })

  test('a reason is one trimmed line of at most 500 characters', () => {
    expect(requestReason('  To test\nthe echo.\u0007 ')).toBe('To test the echo.')
    expect(requestReason('x'.repeat(600))).toHaveLength(500)
    expect(requestReason('   ')).toBeNull()
    expect(requestReason(42)).toBeNull()
  })
})

describe('request', () => {
  const cliEnv = { ATHENA_CLI: '/opt/athena/bin/athena' }
  const isExecutable = (file: string) => file === '/opt/athena/bin/athena'

  test('runs `athena config tool <id> request --reason …` and answers with the access file', async () => {
    const run = vi.fn<RunCli>(async () => {
      writeFileSync(accessFile, JSON.stringify({ packages: { 'stub-echo': { scopes: { 'echo.basic': 'requested' } } } }))

      return { code: 0, stderr: '', stdout: 'Access to Stub echo (dev) requested (echo.basic).\n' }
    })

    const prefs = new AthenaToolPrefs({ env: cliEnv, hermesHome: home, isExecutable, log: () => {}, run })
    const result = await prefs.package('stub-echo', 'request', ' Testing\n ')
    expect(run.mock.calls[0][1]).toEqual(['config', 'tool', 'stub-echo', 'request', '--reason', 'Testing'])
    expect(result).toMatchObject({ ok: true, message: 'Access to Stub echo (dev) requested (echo.basic).' })
    expect(result.access).toEqual({ packages: { 'stub-echo': { scopes: { 'echo.basic': 'requested' }, state: 'active' } } })
    await prefs.package('stub-echo', 'request')
    expect(run.mock.calls[1][1]).toEqual(['config', 'tool', 'stub-echo', 'request'])
    await prefs.package('stub-echo', 'install', 'ignored')
    expect(run.mock.calls[2][1]).toEqual(['config', 'tool', 'stub-echo', 'install'])
  })

  test('a refused request carries the platform reason the CLI printed', async () => {
    const run = vi.fn<RunCli>(async () => ({ code: 1, stderr: 'Access to Stub echo (dev) was not requested: you already hold it\n', stdout: '' }))
    const prefs = new AthenaToolPrefs({ env: cliEnv, hermesHome: home, isExecutable, log: () => {}, run })
    await expect(prefs.package('stub-echo', 'request')).resolves.toMatchObject({ ok: false, message: /already hold it/ })
  })

  test('the access channel is registered and named in the preload bridge', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => void handlers.set(channel, handler) }
    writeFileSync(accessFile, JSON.stringify({ packages: { 'stub-echo': { scopes: { 'echo.basic': 'none' } } } }))
    installAthenaToolPrefs({ env: {}, hermesHome: home, ipcMain: ipcMain as never, launchPath: '', log: () => {} })
    expect(await handlers.get(TOOL_PREFS_CHANNELS.access)!({})).toEqual({
      packages: { 'stub-echo': { scopes: { 'echo.basic': 'none' }, state: 'active' } }
    })
    const bridge = readFileSync(path.join(import.meta.dirname, 'preload-bridge.ts'), 'utf8')
    expect(bridge).toContain(`'${TOOL_PREFS_CHANNELS.access}'`)
    expect(bridge).toMatch(/reason: options\?\.reason/)
  })
})
