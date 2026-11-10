import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG as bundledDefaultFile, TRUSTED_KEYS as trustedKeysFile } from './bundled-config-data'
import {
  AthenaClientConfig,
  BUNDLED_DEFAULT,
  bundledTrustedKeys,
  type ClientConfigSnapshot,
  devOverridesFromEnv,
  signedInSubject
} from './client-config'
import { CLIENT_CONFIG_CHANNELS, installAthenaClientConfig } from './client-config-ipc'

const OID = '00000000-0000-0000-0000-0000000000aa'
const OTHER_OID = '00000000-0000-0000-0000-0000000000bb'
const KID = 'test-kid'
const NOW = Date.parse('2026-11-09T20:00:00Z')

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  return { privateKey, publicKey }
}

const signer = keyPair()
const stranger = keyPair()
const trusted: ReadonlyMap<string, KeyObject> = new Map([[KID, signer.publicKey]])

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '1.0',
    config_version: 118,
    issued_at: '2026-11-09T19:00:00Z',
    expires_at: '2026-11-10T19:00:00Z',
    aud: 'athena-desktop',
    sub: OID,
    role: 'researcher',
    managed: { features: 'enforce', models: 'enforce', tools: 'enforce' },
    features: { S82: 'on' },
    models: { allowed: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol' }], default: 'gpt-6-sol', max_turns_limit: 90 },
    ...overrides
  }
}

function signJws(body: unknown, key = signer.privateKey, header: Record<string, unknown> = {}) {
  const h = b64({ alg: 'EdDSA', kid: KID, typ: 'athena-client-config+jws', ...header })
  const p = b64(body)

  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), key).toString('base64url')}`
}

let home: string
let athenaDir: string

const configFile = () => path.join(athenaDir, 'client-config.jws')
const writeConfig = (token: string) => writeFileSync(configFile(), token)

function signIn(oid = OID) {
  const accessToken = `${b64({ alg: 'none' })}.${b64({ oid, iat: 1 })}.sig`
  writeFileSync(path.join(athenaDir, 'token.json'), JSON.stringify({ access_token: accessToken, expires_at: 0, idp: 'dev' }))
}

function source(extra: Partial<ConstructorParameters<typeof AthenaClientConfig>[0]> = {}) {
  return new AthenaClientConfig({ athenaDir, now: () => NOW, trusted, ...extra })
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-cc-'))
  athenaDir = path.join(home, 'hermes', 'athena')
  mkdirSync(athenaDir, { recursive: true })
  signIn()
})

afterEach(() => rmSync(home, { force: true, recursive: true }))

describe('verifying the signed client config', () => {
  test('a good file is accepted', () => {
    writeConfig(signJws(payload()))
    const snap = source().snapshot()

    expect(snap).toMatchObject({ source: 'server', role: 'researcher', configVersion: 118, error: null })
    expect(snap.config.features).toEqual({ S82: 'on' })
    // Bundled fields the server omitted are filled in underneath.
    expect(snap.config.tools).toEqual(BUNDLED_DEFAULT.tools)
  })

  test.each([
    ['unsigned (alg none)', () => `${b64({ alg: 'none', typ: 'athena-client-config+jws' })}.${b64(payload({ config_version: 200 }))}.`, 'unsupported_alg'],
    ['signed by an unknown key', () => signJws(payload({ config_version: 200 }), stranger.privateKey), 'bad_signature'],
    [
      'edited after signing',
      () => {
        const [h, , s] = signJws(payload({ config_version: 200 })).split('.')

        return `${h}.${b64(payload({ config_version: 200, features: { S82: 'on', S124: 'on' } }))}.${s}`
      },
      'bad_signature'
    ],
    ['for another user', () => signJws(payload({ config_version: 200, sub: OTHER_OID })), 'wrong_subject'],
    ['for another audience', () => signJws(payload({ config_version: 200, aud: 'athena-guard' })), 'wrong_audience'],
    ['of another type', () => signJws(payload({ config_version: 200 }), signer.privateKey, { typ: 'JWT' }), 'wrong_type'],
    ['from a newer schema major', () => signJws(payload({ config_version: 200, schema_version: '2.0' })), 'schema_too_new'],
    ['an older version (replay)', () => signJws(payload({ config_version: 117, role: 'admin' })), 'replayed_version']
  ])('a file %s is ignored and the last good is kept', (_name, token, reason) => {
    writeConfig(signJws(payload()))
    const cc = source()
    expect(cc.snapshot().source).toBe('server')

    writeConfig(token())
    const snap = cc.refresh()

    expect(snap).toMatchObject({ source: 'last-good', configVersion: 118, role: 'researcher', error: reason })
  })

  test('a bad file with nothing held falls back to the bundled default', () => {
    writeConfig(signJws(payload(), stranger.privateKey))
    const snap = source().snapshot()

    expect(snap).toMatchObject({ source: 'bundled', configVersion: null, role: null, error: 'bad_signature' })
    expect(snap.config).toEqual(BUNDLED_DEFAULT)
  })

  test('a deleted file falls back to the bundled default', () => {
    writeConfig(signJws(payload()))
    const cc = source()
    rmSync(configFile())

    expect(cc.refresh()).toMatchObject({ source: 'bundled', configVersion: null, error: 'missing', config: BUNDLED_DEFAULT })
  })

  test('signing in as someone else drops the last good copy of the previous user', () => {
    writeConfig(signJws(payload()))
    const cc = source()
    signIn(OTHER_OID)

    expect(cc.refresh()).toMatchObject({ source: 'bundled', error: 'wrong_subject' })
  })

  test('signed out (no token): the file cannot be bound to a user and is not used', () => {
    rmSync(path.join(athenaDir, 'token.json'))
    writeConfig(signJws(payload()))

    expect(source().snapshot()).toMatchObject({ source: 'bundled', error: 'no_subject' })
  })

  test('a config more than 7 days past its expiry is not used', () => {
    writeConfig(signJws(payload({ expires_at: '2026-11-01T00:00:00Z', issued_at: '2026-10-31T00:00:00Z' })))

    expect(source().snapshot()).toMatchObject({ source: 'bundled', error: 'expired' })
  })

  test('the replay floor survives a restart through desktop-status.json', () => {
    writeConfig(signJws(payload({ config_version: 130 })))
    source()
    writeConfig(signJws(payload({ config_version: 120 })))

    expect(source().snapshot()).toMatchObject({ source: 'bundled', error: 'replayed_version' })
  })

  test('desktop-status.json carries dev_overrides_active and config_version_seen', () => {
    writeConfig(signJws(payload()))
    source()
    const status = JSON.parse(readFileSync(path.join(athenaDir, 'desktop-status.json'), 'utf8'))

    expect(status).toMatchObject({ dev_overrides_active: false, config_version_seen: 118 })
    expect(Date.parse(status.updated_at)).toBe(NOW)
  })

  test('desktop-status.json is refreshed every minute even when nothing changes', () => {
    let now = NOW
    const cc = source({ now: () => now })
    const read = () => JSON.parse(readFileSync(path.join(athenaDir, 'desktop-status.json'), 'utf8'))

    now += 30_000
    cc.refresh()
    expect(Date.parse(read().updated_at)).toBe(NOW)
    now += 31_000
    cc.refresh()
    expect(Date.parse(read().updated_at)).toBe(NOW + 61_000)
  })

  test('the subject is the access token oid, or an explicit oid key', () => {
    expect(signedInSubject(athenaDir)).toBe(OID)
    writeFileSync(path.join(athenaDir, 'token.json'), JSON.stringify({ access_token: 'opaque', oid: OTHER_OID }))
    expect(signedInSubject(athenaDir)).toBe(OTHER_OID)
    writeFileSync(path.join(athenaDir, 'token.json'), '{not json')
    expect(signedInSubject(athenaDir)).toBeNull()
  })
})

describe('dev overrides', () => {
  const overrideFile = () => path.join(home, 'athena-overrides.json')

  test.each([
    ['dev build + env var', { ATHENA_DEV_OVERRIDES: '1' }, null, true],
    ['dev build, no env var', {}, null, false],
    ['dev build, env var not 1', { ATHENA_DEV_OVERRIDES: 'true' }, null, false],
    ['managed release + env var', { ATHENA_DEV_OVERRIDES: '1' }, { athenaManagedRelease: true }, false],
    ['packaged demo build + env var', { ATHENA_DEV_OVERRIDES: '1' }, { brand: 'athena' }, true]
  ])('%s → applied: %s', (_name, env, stamp, applied) => {
    writeConfig(signJws(payload()))
    writeFileSync(overrideFile(), JSON.stringify({ features: { S124: 'on' }, managed: { features: 'off' } }))
    const devOverrides = devOverridesFromEnv({ ...env, ATHENA_DEV_OVERRIDES_FILE: overrideFile() }, stamp, home)
    const snap = source({ devOverrides }).snapshot()

    expect(snap.devOverridesActive).toBe(applied)
    expect(snap.config.features).toEqual(applied ? { S82: 'on', S124: 'on' } : { S82: 'on' })
    expect((snap.config.managed as Record<string, string>).features).toBe(applied ? 'off' : 'enforce')
    expect(JSON.parse(readFileSync(path.join(athenaDir, 'desktop-status.json'), 'utf8')).dev_overrides_active).toBe(applied)
  })

  test('the default override file is ~/athena-demo/athena-overrides.json', () => {
    expect(devOverridesFromEnv({}, null, '/Users/x').file).toBe('/Users/x/athena-demo/athena-overrides.json')
  })

  test('an override applies over the bundled default too, and a broken file is ignored', () => {
    writeFileSync(overrideFile(), JSON.stringify({ features: { S123: 'on' } }))
    const cc = source({ devOverrides: { allowed: true, file: overrideFile() } })

    expect(cc.snapshot()).toMatchObject({ source: 'bundled', devOverridesActive: true, config: { features: { S123: 'on' } } })
    writeFileSync(overrideFile(), '{oops')
    expect(cc.refresh()).toMatchObject({ devOverridesActive: false, config: { features: {} } })
  })
})

describe('watching', () => {
  test('a new file is picked up within the poll interval, and pushed to every window', async () => {
    writeConfig(signJws(payload()))
    const sent: unknown[][] = []
    const handlers = new Map<string, (...args: any[]) => unknown>()

    const ipcMain = {
      handle: (channel: string, fn: (...args: any[]) => unknown) => handlers.set(channel, fn),
      on: (channel: string, fn: (...args: any[]) => unknown) => handlers.set(channel, fn)
    }

    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) } }

    const cc = installAthenaClientConfig({
      allWindows: () => [win as any],
      athenaDir,
      env: {},
      installStamp: null,
      ipcMain: ipcMain as any,
      log: () => {}
    })

    // Swap in the test key: the installed source verifies with the bundled keys.
    ;(cc as any).trusted = trusted
    cc.refresh()
    cc.start(50)

    try {
      const event: { returnValue?: ClientConfigSnapshot } = {}
      handlers.get(CLIENT_CONFIG_CHANNELS.snapshot)!(event)
      expect(event.returnValue).toMatchObject({ configVersion: 118 })

      writeConfig(signJws(payload({ config_version: 119, features: {} })))
      await vi.waitFor(() => expect(sent.at(-1)?.[1]).toMatchObject({ configVersion: 119, source: 'server' }), {
        timeout: 1000
      })
      expect(sent.at(-1)?.[0]).toBe(CLIENT_CONFIG_CHANNELS.changed)
      expect(await handlers.get(CLIENT_CONFIG_CHANNELS.get)!()).toMatchObject({ configVersion: 119 })
    } finally {
      cc.stop()
    }
  })
})

describe('bundled data', () => {
  // The athena repo is the source of truth; compare when a checkout is present (ATHENA_REPO, else the usual path).
  const athenaRepo = path.join(
    process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena'),
    'shared/athena_schemas/src/athena_schemas/data'
  )

  test('the bundled trusted keys load', () => {
    expect([...bundledTrustedKeys().keys()]).toEqual(trustedKeysFile.keys.map(key => key.kid))
  })

  test.skipIf(!existsSync(athenaRepo))('the bundled copies match the athena repo', () => {
    expect(trustedKeysFile).toEqual(JSON.parse(readFileSync(path.join(athenaRepo, 'trusted-keys.json'), 'utf8')))
    expect(bundledDefaultFile).toEqual(JSON.parse(readFileSync(path.join(athenaRepo, 'client-config.default.json'), 'utf8')))
  })
})

describe('managed-release build stamp', () => {
  const stamp = { commit: 'c'.repeat(40), branch: 'main', builtAt: '2026-11-09T00:00:00Z', dirty: false, source: 'ci' }

  test('only an athena build with ATHENA_MANAGED_RELEASE=1 is stamped a managed release', async () => {
    const { buildStampPayload } = await import('../../scripts/write-build-stamp.mjs')
    const managed = buildStampPayload(stamp, { HERMES_DESKTOP_VARIANT: 'athena', ATHENA_MANAGED_RELEASE: '1' }, 'darwin')
    const demo = buildStampPayload(stamp, { HERMES_DESKTOP_VARIANT: 'athena' }, 'darwin')
    const stock = buildStampPayload(stamp, { ATHENA_MANAGED_RELEASE: '1' }, 'darwin')

    expect(managed.athenaManagedRelease).toBe(true)
    expect(demo).not.toHaveProperty('athenaManagedRelease')
    expect(stock).not.toHaveProperty('athenaManagedRelease')
    expect(devOverridesFromEnv({ ATHENA_DEV_OVERRIDES: '1' }, managed).allowed).toBe(false)
    expect(devOverridesFromEnv({ ATHENA_DEV_OVERRIDES: '1' }, demo).allowed).toBe(true)
  })
})
