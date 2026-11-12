// F03 slice 19: main re-verifies the signed remote catalog the shipper stored, with the app's own keys, and takes only
// gateway and skill packages. The fixture is written from the athena repo's rules (`write_desktop_fixture` in
// athena's tests/client/test_remote_catalog.py), which checks the same outcomes on its side.
import { generateKeyPairSync, type JsonWebKey, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { AthenaCatalogSource, CATALOG_CHANNELS, installAthenaCatalogSource } from './catalog-source'
import { trustedKeys } from './jws'
import { acceptRemote, canonicalJson, CatalogRefused, filesSha256, verifyRemoteCatalog } from './remote-catalog'

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'remote-catalog.json'), 'utf8'))
const trusted = trustedKeys(fixture.trusted_keys as JsonWebKey[])
const NOW = Date.parse(fixture.now)
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof CatalogRefused) {
      return error.reason
    }

    throw error
  }

  return 'accepted'
}

function athenaDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'athena-remote-catalog-'))
  dirs.push(dir)

  return dir
}

const ON = { catalog: { remote: true } }

describe('the remote catalog rules in main', () => {
  test('hash and canonical JSON agree with the athena repo', () => {
    expect(filesSha256(fixture.files_sha256.files)).toBe(fixture.files_sha256.sha256)
    expect(canonicalJson({ b: [1, { d: 'é', c: null }], a: true })).toBe('{"a":true,"b":[1,{"c":null,"d":"é"}]}')
  })

  test('takes the gateway and skill packages and refuses the rest with the same reasons', () => {
    const doc = verifyRemoteCatalog(fixture.token, trusted, null, NOW)
    const { accepted, rejected } = acceptRemote(doc)
    expect(Object.keys(accepted).sort()).toEqual(fixture.expected.accepted)
    expect(Object.fromEntries(rejected.map(r => [r.id, r.reason]))).toEqual(fixture.expected.rejected)
  })

  test('refuses a foreign key, another typ, a version below the floor and an expired copy', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'other' }
    const [h, p] = fixture.token.split('.')
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const reHeader = Buffer.from(JSON.stringify({ ...header, kid: 'other' })).toString('base64url')
    const forged = `${reHeader}.${p}.${sign(null, Buffer.from(`${reHeader}.${p}`), privateKey).toString('base64url')}`
    expect(refusal(() => verifyRemoteCatalog(forged, trusted, null, NOW))).toBe('unknown_kid')
    expect(refusal(() => verifyRemoteCatalog(forged, trustedKeys([jwk]), null, NOW))).toBe('accepted')
    expect(refusal(() => verifyRemoteCatalog(fixture.wrong_typ, trusted, null, NOW))).toBe('wrong_typ')
    expect(refusal(() => verifyRemoteCatalog(fixture.older, trusted, '2026.11.4', NOW))).toBe('replayed_version')
    expect(refusal(() => verifyRemoteCatalog(fixture.token, trusted, '2026.11.4', NOW))).toBe('accepted')
    expect(refusal(() => verifyRemoteCatalog(fixture.token, trusted, null, NOW + 9 * 86_400_000))).toBe('last_good_expired')
  })
})

describe('the catalog source in main', () => {
  test('bundled while the switch is off; the verified packages while it is on', () => {
    const dir = athenaDir()
    writeFileSync(path.join(dir, 'catalog.jws'), `${fixture.token}\n`)
    let config: unknown = {}
    const source = new AthenaCatalogSource({ athenaDir: dir, config: () => config, now: () => NOW, trusted })
    expect(source.current()).toEqual({ catalog: null, error: null, source: 'bundled' })
    config = ON
    const on = source.current()
    expect(on.source).toBe('remote')
    expect(Object.keys(on.catalog!.entries).sort()).toEqual(fixture.expected.accepted)
    expect(on.rejected!.map(r => r.id).sort()).toEqual(Object.keys(fixture.expected.rejected).sort())
    expect(JSON.parse(readFileSync(path.join(dir, 'desktop-catalog.json'), 'utf8'))).toEqual({ catalog_version_seen: '2026.11.4' })
  })

  test('an older copy put back is refused on main floor alone; a failed sync shows last_good', () => {
    const dir = athenaDir()
    const source = new AthenaCatalogSource({ athenaDir: dir, config: () => ON, now: () => NOW, trusted })
    writeFileSync(path.join(dir, 'catalog.jws'), fixture.token)
    expect(source.current().source).toBe('remote')
    writeFileSync(path.join(dir, 'catalog.state.json'), JSON.stringify({ error: 'unreachable: ConnectError' }))
    expect(source.current()).toMatchObject({ error: 'unreachable: ConnectError', source: 'last_good' })
    writeFileSync(path.join(dir, 'catalog.jws'), fixture.older) // the shipper's state says nothing about the floor
    expect(source.current()).toEqual({ catalog: null, error: 'replayed_version', source: 'bundled' })
    writeFileSync(path.join(dir, 'catalog.jws'), 'not.a.token')
    expect(source.current()).toEqual({ catalog: null, error: 'malformed', source: 'bundled' })
  })

  test('answers on the Athena channels', async () => {
    const dir = athenaDir()
    writeFileSync(path.join(dir, 'catalog.jws'), fixture.token)
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (c: string, fn: (...args: any[]) => unknown) => handlers.set(c, fn), on: (c: string, fn: (...args: any[]) => unknown) => handlers.set(c, fn) }
    const lines: string[] = []
    installAthenaCatalogSource(ipcMain as never, line => lines.push(line), new AthenaCatalogSource({ athenaDir: dir, config: () => ON, now: () => NOW, trusted }))
    expect(((await handlers.get(CATALOG_CHANNELS.get)!()) as { source: string }).source).toBe('remote')
    expect(lines).toEqual(['[athena] tool catalog: remote 2026.11.4'])
  })
})
