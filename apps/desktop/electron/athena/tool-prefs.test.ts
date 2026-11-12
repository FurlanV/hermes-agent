import { generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  AthenaToolPrefs,
  installAthenaToolPrefs,
  readToolPrefs,
  resolveAthenaCli,
  type RunCli,
  TOOL_PREFS_CHANNELS,
  writeToolPref
} from './tool-prefs'

let home: string
let prefsFile: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-tp-'))
  prefsFile = path.join(home, 'athena', 'tool-prefs.json')
})

afterEach(() => rmSync(home, { force: true, recursive: true }))

function fakeCli(dir: string, name = 'athena'): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)

  return file
}

describe('the prefs file', () => {
  test('reads the enabled map and ignores junk, like the applier', () => {
    expect(readToolPrefs(prefsFile)).toEqual({})
    mkdirSync(path.dirname(prefsFile), { recursive: true })
    writeFileSync(prefsFile, JSON.stringify({ enabled: { python: 'no', terminal: false }, other: 1 }))
    expect(readToolPrefs(prefsFile)).toEqual({ terminal: false })
    writeFileSync(prefsFile, 'not json')
    expect(readToolPrefs(prefsFile)).toEqual({})
  })

  test("writes the CLI's format: one toggle merged, sorted, 2-space JSON, 0600", () => {
    mkdirSync(path.dirname(prefsFile), { recursive: true })
    writeFileSync(prefsFile, JSON.stringify({ other: 1, enabled: { terminal: false } }))
    expect(writeToolPref(prefsFile, 'python', false)).toEqual({ python: false, terminal: false })
    // Byte for byte what athena_shipper.tool_pins.write_pref writes (json.dumps(indent=2, sort_keys=True) + "\n").
    expect(readFileSync(prefsFile, 'utf8')).toBe(
      '{\n  "enabled": {\n    "python": false,\n    "terminal": false\n  },\n  "other": 1\n}\n'
    )
    expect(statSync(prefsFile).mode & 0o777).toBe(0o600)
  })
})

describe('finding the athena CLI', () => {
  test('ATHENA_CLI first, then athena on the launch PATH; relative and missing entries never', () => {
    const launcherBin = path.join(home, 'venv', 'bin')
    const explicit = fakeCli(path.join(home, 'explicit'))
    const onPath = fakeCli(launcherBin)

    expect(resolveAthenaCli({ ATHENA_CLI: explicit }, launcherBin)).toBe(explicit)
    expect(resolveAthenaCli({}, `relative/bin${path.delimiter}${path.join(home, 'none')}${path.delimiter}${launcherBin}`)).toBe(onPath)
    // A broken ATHENA_CLI falls back to the launch PATH.
    expect(resolveAthenaCli({ ATHENA_CLI: path.join(home, 'gone', 'athena') }, launcherBin)).toBe(onPath)
    expect(resolveAthenaCli({ ATHENA_CLI: 'athena' }, '')).toBeNull()
    expect(resolveAthenaCli({}, undefined)).toBeNull()
  })

  test('the launch PATH is captured at install, so a later login-shell PATH merge cannot swap the binary', () => {
    const launcherBin = path.join(home, 'venv', 'bin')
    const shellBin = path.join(home, 'shell', 'bin')
    const ours = fakeCli(launcherBin)
    fakeCli(shellBin)
    const env: Record<string, string | undefined> = { PATH: launcherBin }
    const prefs = new AthenaToolPrefs({ env, hermesHome: home, log: () => {} })
    env.PATH = `${shellBin}${path.delimiter}${launcherBin}` // what ensureLoginShellPath does to process.env later

    expect(prefs.cli()).toBe(ours)
  })
})

describe('a toggle', () => {
  const cli = () => fakeCli(path.join(home, 'bin'))

  test('runs `athena config tool <id> off` on this Profile and reads the prefs back', async () => {
    const athena = cli()

    const run = vi.fn<RunCli>(async () => {
      writeToolPref(prefsFile, 'literature-search', false) // what the real CLI does before it applies

      return { code: 0, stderr: '', stdout: 'Literature search: off. Applies to new chats.\nManaged: … (updated)\n' }
    })

    const lines: string[] = []

    const prefs = new AthenaToolPrefs({
      env: { ATHENA_CLI: athena, PATH: '/usr/bin', PYTHONPATH: '/elsewhere', VIRTUAL_ENV: '/v' },
      hermesHome: home,
      log: line => lines.push(line),
      run
    })

    await expect(prefs.set('literature-search', false)).resolves.toEqual({
      applied: true,
      enabled: { 'literature-search': false },
      message: 'Literature search: off. Applies to new chats.',
      ok: true
    })
    expect(run).toHaveBeenCalledTimes(1)
    const [file, args, env] = run.mock.calls[0]
    expect([file, args]).toEqual([athena, ['config', 'tool', 'literature-search', 'off']])
    expect(env).toMatchObject({ ATHENA_CLI: athena, HERMES_HOME: home, PATH: '/usr/bin' })
    expect(env).not.toHaveProperty('PYTHONPATH')
    expect(env).not.toHaveProperty('VIRTUAL_ENV')
    expect(lines.join('\n')).toContain('config tool literature-search off: exit 0')
  })

  test("a CLI failure is reported with the CLI's reason and changes nothing", async () => {
    const run = vi.fn<RunCli>(async () => ({ code: 1, stderr: 'Browser is not available for your role\n', stdout: '' }))
    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: cli() }, hermesHome: home, log: () => {}, run })

    await expect(prefs.set('browser', true)).resolves.toEqual({
      applied: false,
      enabled: {},
      message: 'Browser is not available for your role',
      ok: false
    })
  })

  test('without a CLI, main writes the file itself and says it applies after the next sync', async () => {
    const run = vi.fn<RunCli>()
    const prefs = new AthenaToolPrefs({ env: {}, hermesHome: home, launchPath: '', log: () => {}, run })
    const result = await prefs.set('python', false)

    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ applied: false, enabled: { python: false }, ok: true })
    expect(result.message).toMatch(/next config sync/)
    expect(readToolPrefs(prefsFile)).toEqual({ python: false })
  })

  test.each([
    ['--help', true],
    ['../x', false],
    ['', true],
    [42, true],
    ['python', 'yes']
  ])('refuses a bad request (%j, %j) before it reaches argv', async (id, on) => {
    const run = vi.fn<RunCli>()
    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: cli() }, hermesHome: home, log: () => {}, run })

    await expect(prefs.set(id, on)).resolves.toMatchObject({ applied: false, ok: false })
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(prefsFile)).toBe(false)
  })

  test('toggles run one at a time, in order', async () => {
    const order: string[] = []

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))

    const run = vi.fn<RunCli>(async (_file, args) => {
      order.push(`start ${args[2]}`)

      if (args[2] === 'python') {
        await gate
      }

      order.push(`end ${args[2]}`)

      return { code: 0, stderr: '', stdout: 'ok' }
    })

    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: cli() }, hermesHome: home, log: () => {}, run })
    const first = prefs.set('python', false)
    const second = prefs.set('terminal', false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['start python'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start python', 'end python', 'start terminal', 'end terminal'])
  })
})

describe('the IPC channels', () => {
  test('get and set are registered on the Athena channel names the preload bridge uses', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) }
    const run = vi.fn<RunCli>(async () => ({ code: 0, stderr: '', stdout: 'Python: off. Applies to new chats.' }))
    installAthenaToolPrefs({ env: { ATHENA_CLI: fakeCli(path.join(home, 'bin')) }, hermesHome: home, ipcMain: ipcMain as never, log: () => {}, run })

    expect([...handlers.keys()].sort()).toEqual(Object.values(TOOL_PREFS_CHANNELS).sort())
    expect(await handlers.get(TOOL_PREFS_CHANNELS.get)!({})).toEqual({})
    await expect(handlers.get(TOOL_PREFS_CHANNELS.set)!({}, { id: 'python', on: false })).resolves.toMatchObject({ ok: true })
    expect(run.mock.calls[0][1]).toEqual(['config', 'tool', 'python', 'off'])
    await expect(handlers.get(TOOL_PREFS_CHANNELS.set)!({}, 'junk')).resolves.toMatchObject({ ok: false })

    const bridge = readFileSync(path.join(import.meta.dirname, 'preload-bridge.ts'), 'utf8')

    for (const channel of Object.values(TOOL_PREFS_CHANNELS)) {
      expect(bridge).toContain(`'${channel}'`)
    }
  })
})

describe('package actions (F03 slices 20-22)', () => {
  test('install, remove and accept run `athena config tool <id> <action>` and read the installed records back', async () => {
    const run = vi.fn<RunCli>(async (_file, args) => {
      mkdirSync(path.dirname(prefsFile), { recursive: true })
      writeFileSync(prefsFile, JSON.stringify({ enabled: { [args[2]]: true }, installed: { [args[2]]: { sha256: 'a'.repeat(64), version: '1.0.0' }, junk: 3 } }))

      return { code: 0, stderr: '', stdout: 'Remote echo 1.0.0 installed. Applies to new chats.\n' }
    })

    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: fakeCli(path.join(home, 'bin')) }, hermesHome: home, log: () => {}, run })
    const result = await prefs.package('remote-echo', 'install')
    expect(run.mock.calls[0][1]).toEqual(['config', 'tool', 'remote-echo', 'install'])
    expect(run.mock.calls[0][2].HERMES_HOME).toBe(home)
    expect(result).toEqual({
      applied: true,
      enabled: { 'remote-echo': true },
      installed: { 'remote-echo': { sha256: 'a'.repeat(64), version: '1.0.0' } },
      message: 'Remote echo 1.0.0 installed. Applies to new chats.',
      ok: true
    })
    await prefs.package('remote-echo', 'remove')
    await prefs.package('remote-echo', 'accept')
    expect(run.mock.calls.map(call => call[1][3])).toEqual(['install', 'remove', 'accept'])
  })

  test('anything else, or no CLI, is refused and nothing is written', async () => {
    const run = vi.fn<RunCli>()
    const prefs = new AthenaToolPrefs({ env: { ATHENA_CLI: fakeCli(path.join(home, 'bin')) }, hermesHome: home, log: () => {}, run })
    await expect(prefs.package('remote-echo', 'download')).resolves.toMatchObject({ ok: false })
    await expect(prefs.package('../etc', 'install')).resolves.toMatchObject({ ok: false })
    const noCli = new AthenaToolPrefs({ env: {}, hermesHome: home, launchPath: '', log: () => {}, run })
    await expect(noCli.package('remote-echo', 'install')).resolves.toMatchObject({ ok: false, message: /command-line tool/ })
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(prefsFile)).toBe(false)
  })
})

// The real athena CLI, when an athena checkout with its venv is present (ATHENA_REPO, else the usual path): a
// researcher's signed config (signed here, trusted through ATHENA_CLIENT_CONFIG_TRUSTED_KEYS), then the Capabilities
// toggle for Literature search. The CLI writes tool-prefs.json and re-applies managed scope without `web`.
const athenaRepo = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const realCli = path.join(athenaRepo, '.venv', 'bin', 'athena')

describe.skipIf(!existsSync(realCli))('with the real athena CLI', () => {
  const OID = '00000000-0000-0000-0000-0000000000aa'
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  function seedProfile(): Record<string, string> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const athenaDir = path.join(home, 'athena')
    mkdirSync(athenaDir, { recursive: true })
    const keys = path.join(home, 'trusted-keys.json')
    writeFileSync(keys, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid: 'test', use: 'sig' }] }))
    const now = Date.now()
    const tools = ['files', 'memory', 'literature-search', 'clarify', 'desktop-projects']

    const body = {
      aud: 'athena-desktop',
      catalog: { min_version: null },
      config_version: 7,
      expires_at: new Date(now + 86_400_000).toISOString(),
      features: {},
      issued_at: new Date(now - 60_000).toISOString(),
      managed: { features: 'enforce', models: 'enforce', tools: 'enforce' },
      models: { allowed: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }], default: 'gpt-6-luna', max_turns_limit: 90 },
      role: 'researcher',
      schema_version: '1.0',
      sub: OID,
      tools: { available: tools, default_on: tools, experimental: [], locked_on: ['files', 'memory', 'clarify', 'desktop-projects'] }
    }

    const header = b64({ alg: 'EdDSA', kid: 'test', typ: 'athena-client-config+jws' })
    const payload = b64(body)
    const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
    writeFileSync(path.join(athenaDir, 'client-config.jws'), `${header}.${payload}.${signature}\n`)
    const accessToken = `${b64({ alg: 'none' })}.${b64({ oid: OID })}.sig`
    writeFileSync(path.join(athenaDir, 'token.json'), JSON.stringify({ access_token: accessToken, expires_at: now / 1000 + 3600 }))

    return { ATHENA_CLIENT_CONFIG_TRUSTED_KEYS: keys, HOME: homedir(), PATH: '/usr/bin:/bin' }
  }

  const ceiling = () => {
    const managed = readFileSync(path.join(home, 'athena', 'managed', 'config.yaml'), 'utf8')
    const block = /platform_toolsets:\n {2}cli:\n((?: {2}- .+\n)+)/.exec(managed)?.[1] ?? ''

    return block.split('\n').map(line => line.replace(/^ {2}- /, '').trim()).filter(Boolean)
  }

  test('turning Literature search off writes tool-prefs.json and re-applies managed scope without web', { timeout: 60_000 }, async () => {
    const env = { ...seedProfile(), ATHENA_CLI: realCli }
    const prefs = new AthenaToolPrefs({ env, hermesHome: home, log: () => {} })

    const on = await prefs.set('literature-search', true)
    expect(on).toMatchObject({ applied: true, enabled: { 'literature-search': true }, ok: true })
    expect(ceiling()).toEqual(expect.arrayContaining(['file', 'web', 'memory', 'clarify', 'project']))

    const off = await prefs.set('literature-search', false)
    expect(off).toMatchObject({ applied: true, enabled: { 'literature-search': false }, ok: true })
    expect(off.message).toBe('Literature search: off. Applies to new chats.')
    expect(readToolPrefs(prefsFile)).toEqual({ 'literature-search': false })
    expect(ceiling()).not.toContain('web')
    expect(ceiling()).toEqual(expect.arrayContaining(['file', 'memory', 'clarify', 'project']))

    // A locked entry: the CLI keeps it on and says so.
    const locked = await prefs.set('files', false)
    expect(locked.ok).toBe(true)
    expect(locked.message).toMatch(/managed by your administrator/)
    expect(ceiling()).toContain('file')
  })
})
