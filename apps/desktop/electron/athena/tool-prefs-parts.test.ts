// F11 slice 07: a package's source switch over `athena:tool-prefs:set-part` runs `athena config tool <id>/<part>
// on|off`; without the CLI main writes `enabled["<id>/<part>"]` in tool-prefs.json itself, so the switch survives a
// restart (a new main reads the same file back). Anything that is not an entry id and a part id never reaches argv.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { AthenaToolPrefs, installAthenaToolPrefs, readToolPrefs, type RunCli, TOOL_PREFS_CHANNELS, writeToolPref } from './tool-prefs'

let home: string
let prefsFile: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-parts-'))
  prefsFile = path.join(home, 'athena', 'tool-prefs.json')
})

afterEach(() => rmSync(home, { force: true, recursive: true }))

function fakeCli(): string {
  const dir = path.join(home, 'bin')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'athena')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)

  return file
}

describe('a source switch', () => {
  test('runs `athena config tool <id>/<part> off` and reads the prefs back', async () => {
    const athena = fakeCli()

    const run = vi.fn<RunCli>(async () => {
      writeToolPref(prefsFile, 'disease-evidence/panelapp', false) // what the real CLI writes before it applies

      return { code: 0, stderr: '', stdout: 'PanelApp in Disease evidence: off. Applies to new chats.\n' }
    })

    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: athena }, hermesHome: home, log: () => {}, run })

    await expect(prefs.setPart('disease-evidence', 'panelapp', false)).resolves.toEqual({
      applied: true,
      enabled: { 'disease-evidence/panelapp': false },
      message: 'PanelApp in Disease evidence: off. Applies to new chats.',
      ok: true
    })
    expect(run.mock.calls[0][1]).toEqual(['config', 'tool', 'disease-evidence/panelapp', 'off'])
  })

  test('without a CLI it is written to tool-prefs.json and a restarted main reads it back', async () => {
    const first = new AthenaToolPrefs({ env: {}, hermesHome: home, launchPath: '', log: () => {} })
    await expect(first.setPart('disease-evidence', 'panelapp', false)).resolves.toMatchObject({ ok: true })
    await first.set('disease-evidence', true)

    const restarted = new AthenaToolPrefs({ env: {}, hermesHome: home, launchPath: '', log: () => {} })
    expect(restarted.prefs()).toEqual({ 'disease-evidence': true, 'disease-evidence/panelapp': false })
    expect(readToolPrefs(prefsFile)).toEqual(restarted.prefs())
  })

  test.each([
    ['disease-evidence', '../x', false],
    ['disease-evidence', 'pan/elapp', false],
    ['--help', 'panelapp', true],
    ['disease-evidence', '', true],
    ['disease-evidence', 'panelapp', 'no'],
    [42, 'panelapp', true]
  ])('refuses a bad request (%j, %j, %j) before it reaches argv', async (id, part, on) => {
    const run = vi.fn<RunCli>()
    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: fakeCli() }, hermesHome: home, log: () => {}, run })

    await expect(prefs.setPart(id, part, on)).resolves.toMatchObject({ applied: false, ok: false })
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(prefsFile)).toBe(false)
  })

  test("a CLI refusal (an administrator's lock) comes back with the CLI's reason", async () => {
    const run = vi.fn<RunCli>(async () => ({
      code: 1,
      stderr: 'SFARI in Disease evidence is set by your administrator: it stays off.\n',
      stdout: ''
    }))

    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: fakeCli() }, hermesHome: home, log: () => {}, run })

    await expect(prefs.setPart('disease-evidence', 'sfari', true)).resolves.toEqual({
      applied: false,
      enabled: {},
      message: 'SFARI in Disease evidence is set by your administrator: it stays off.',
      ok: false
    })
  })

  test('is registered on the channel the preload bridge uses', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) }
    const run = vi.fn<RunCli>(async () => ({ code: 0, stderr: '', stdout: 'ok' }))
    installAthenaToolPrefs({ env: { ATHENA_CLI: fakeCli() }, hermesHome: home, ipcMain: ipcMain as never, log: () => {}, run })

    const setPart = handlers.get(TOOL_PREFS_CHANNELS.setPart)!
    await expect(setPart({}, { id: 'disease-evidence', on: true, part: 'clingen' })).resolves.toMatchObject({ ok: true })
    expect(run.mock.calls[0][1]).toEqual(['config', 'tool', 'disease-evidence/clingen', 'on'])
    await expect(setPart({}, 'junk')).resolves.toMatchObject({ ok: false })
  })
})
