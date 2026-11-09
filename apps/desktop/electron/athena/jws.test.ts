import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import electron from 'electron'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type JwsCaseResult, type JwsFixture, verifyFixture } from './fixtures/jws-verify-fixture'
import { b64urlDecode, JwsError, keyFromJwk, trustedKeys, verifyCompactJws } from './jws'

// Signed by the athena repo's Python signer (tests/spikes/jws_ed25519.py sign-fixture) with a throwaway key.
const fixturePath = path.join(import.meta.dirname, 'fixtures/jws-ed25519.json')
const fixture: JwsFixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const expected = fixture.cases.map(({ name, expect }) => ({ name, reason: expect }))
const reasons = (results: JwsCaseResult[]) => results.map(({ name, reason }) => ({ name, reason }))
const nativeAvailable = process.platform !== 'linux' || Boolean(process.env.DISPLAY)

describe('Ed25519 compact JWS from the Athena signer', () => {
  it('accepts the good token and rejects every tampered form with the reference reason', () => {
    const results = verifyFixture(fixture)

    expect(reasons(results)).toEqual(expected)
    expect(results[0]).toEqual({ name: 'good', reason: 'ok', payload: fixture.payload })
  })

  it('rejects unknown and missing kid', () => {
    const results = Object.fromEntries(verifyFixture(fixture).map(r => [r.name, r.reason]))

    expect(results.unknown_kid).toBe('unknown_kid')
    expect(results.missing_kid).toBe('missing_kid')
    expect(results.empty_kid).toBe('missing_kid')
  })

  it('needs strict base64url: Buffer decodes the non-canonical signature to the same bytes', () => {
    const token = (name: string) => fixture.cases.find(c => c.name === name)!.token
    const lenient = Buffer.from(token('noncanonical_signature').split('.')[2], 'base64url')

    expect(lenient.equals(Buffer.from(token('good').split('.')[2], 'base64url'))).toBe(true)
    expect(() => b64urlDecode(token('noncanonical_signature').split('.')[2])).toThrow(JwsError)
  })

  it('verifies a token signed in Node with a fresh key and refuses keys that are not Ed25519', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' }
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const input = `${enc({ alg: 'EdDSA', kid: 'k1' })}.${enc({ config_version: 1 })}`
    const token = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`

    expect(verifyCompactJws(token, trustedKeys([jwk])).payload.toString()).toBe('{"config_version":1}')

    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })

    expect(() => keyFromJwk(ec)).toThrow(/Ed25519/)
  })
})

// The vitest worker runs the system Node (26); Electron 44 main runs Node 24 on BoringSSL. Run the same
// verifier there as a real main process.
describe.skipIf(!nativeAvailable)('Ed25519 compact JWS in Electron main', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'athena-jws-'))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('gives the same results as the reference verifier', async () => {
    const artifact = path.join(root, 'app')
    const out = path.join(root, 'results.json')
    buildSync({
      entryPoints: [path.join(import.meta.dirname, 'fixtures/jws-electron-main.ts')],
      outfile: path.join(artifact, 'main.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['electron']
    })
    writeFileSync(
      path.join(artifact, 'package.json'),
      JSON.stringify({ name: 'athena-jws-fixture', version: '0.0.0', main: 'main.mjs', type: 'module' })
    )

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const options = { fixture: fixturePath, out, userData: path.join(root, 'user-data') }

    const child = spawn(String(electron), [artifact, `--jws-fixture=${JSON.stringify(options)}`], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr!.on('data', data => {
      stderr += String(data)
    })
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve))

    expect(code, stderr).toBe(0)

    const { runtime, results } = JSON.parse(readFileSync(out, 'utf8'))

    expect(runtime).toMatchObject({ type: 'browser', electron: expect.any(String), boringssl: true })
    expect(reasons(results)).toEqual(expected)
    expect(results[0].payload).toEqual(fixture.payload)
  })
})
