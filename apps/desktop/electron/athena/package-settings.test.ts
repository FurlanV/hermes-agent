// F03 slice 27: main reads the user's package settings from tool-prefs.json and saves them through
// `athena config settings <id> --values <json>` (`--clear` for none); only a small flat map reaches the CLI's argv.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  AthenaToolPrefs,
  readPackageSettings,
  type RunCli,
  settingsArgument,
  TOOL_PREFS_CHANNELS
} from './tool-prefs'

let home: string
let prefsFile: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-settings-'))
  prefsFile = path.join(home, 'athena', 'tool-prefs.json')
  mkdirSync(path.dirname(prefsFile), { recursive: true })
})

afterEach(() => rmSync(home, { force: true, recursive: true }))

const cliEnv = { ATHENA_CLI: '/opt/athena/bin/athena' }
const isExecutable = (file: string) => file === '/opt/athena/bin/athena'

describe('package settings', () => {
  test('reads well-formed values per package only', () => {
    expect(readPackageSettings(prefsFile)).toEqual({})
    writeFileSync(
      prefsFile,
      JSON.stringify({
        enabled: { 'stub-echo': true },
        settings: { 'BAD ID': { a: 1 }, 'stub-echo': { 'Bad-Key': 1, nested: { x: 1 }, shout: true, species: 'mouse' } }
      })
    )
    expect(readPackageSettings(prefsFile)).toEqual({ 'stub-echo': { shout: true, species: 'mouse' } })
  })

  test('only a small flat map of setting ids to text, numbers and toggles becomes --values', () => {
    expect(settingsArgument({ max_results: 20, shout: false, species: 'mouse' })).toBe(
      '{"max_results":20,"shout":false,"species":"mouse"}'
    )
    expect(settingsArgument({ species: { nested: 1 } })).toBeNull()
    expect(settingsArgument({ 'Bad-Key': 1 })).toBeNull()
    expect(settingsArgument({ text: 'x'.repeat(201) })).toBeNull()
    expect(settingsArgument(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])))).toBeNull()
    expect(settingsArgument('{}')).toBeNull()
  })

  test('saving runs `athena config settings <id> --values …`, or --clear, and reads the values back', async () => {
    const run = vi.fn<RunCli>(async (_file, args) => {
      writeFileSync(prefsFile, JSON.stringify({ settings: args[3] === '--clear' ? {} : { 'stub-echo': JSON.parse(args[4]) } }))

      return { code: 0, stderr: '', stdout: 'Settings of Stub echo (dev) saved. Applies to new chats.\n' }
    })

    const prefs = new AthenaToolPrefs({ env: cliEnv, hermesHome: home, isExecutable, log: () => {}, run })
    const saved = await prefs.setSettings('stub-echo', { species: 'mouse' })
    expect(run.mock.calls[0][1]).toEqual(['config', 'settings', 'stub-echo', '--values', '{"species":"mouse"}'])
    expect(saved).toEqual({
      applied: true,
      message: 'Settings of Stub echo (dev) saved. Applies to new chats.',
      ok: true,
      settings: { 'stub-echo': { species: 'mouse' } }
    })
    await prefs.setSettings('stub-echo', {})
    expect(run.mock.calls[1][1]).toEqual(['config', 'settings', 'stub-echo', '--clear'])
    await expect(prefs.setSettings('stub-echo', { species: ['x'] })).resolves.toMatchObject({ ok: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('a value the CLI refuses comes back with its message; no CLI, nothing is written', async () => {
    const run = vi.fn<RunCli>(async () => ({
      code: 1,
      stderr: 'Settings of Stub echo (dev) not saved: Species: must be one of human, mouse\n',
      stdout: ''
    }))

    const prefs = new AthenaToolPrefs({ env: cliEnv, hermesHome: home, isExecutable, log: () => {}, run })
    await expect(prefs.setSettings('stub-echo', { species: 'cat' })).resolves.toMatchObject({
      message: /must be one of human, mouse/,
      ok: false
    })
    const noCli = new AthenaToolPrefs({ env: {}, hermesHome: home, launchPath: '', log: () => {}, run })
    await expect(noCli.setSettings('stub-echo', { species: 'mouse' })).resolves.toMatchObject({ message: /command-line tool/, ok: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('both channels are named in the preload bridge', () => {
    const bridge = readFileSync(path.join(import.meta.dirname, 'preload-bridge.ts'), 'utf8')
    expect(bridge).toContain(`'${TOOL_PREFS_CHANNELS.settings}'`)
    expect(bridge).toContain(`'${TOOL_PREFS_CHANNELS.setSettings}'`)
  })
})
