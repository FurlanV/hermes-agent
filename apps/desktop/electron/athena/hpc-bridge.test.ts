// F05 slice 06: the HPC bridge. Electron main opens an SSH connection to the login host of the client config,
// forwards a loopback port to the model server, writes the Profile's bridge record while the forward is up and
// removes it when it is not, checks the login host against the pinned host key before it signs in, comes back after
// a drop, and does nothing while feature row F05 is off. Everything runs against a stand-in login node and model
// server on loopback (hpc-bridge.test-helper.ts); no real host is contacted.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { isPolicyIpcChannel } from './backend-policy'
import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { AthenaClientConfig } from './client-config'
import type { ClientConfigSnapshot } from './client-config-types'
import {
  BRIDGE_PORT_FILE,
  BRIDGE_TIMINGS,
  bridgeOffReason,
  bridgeTarget,
  HPC_BRIDGE_CHANNELS,
  HpcBridge,
  type HpcBridgeOptions,
  type HpcBridgeStatus,
  installAthenaHpcBridge,
  readStoredPort
} from './hpc-bridge'
import { HPC_BRIDGE_HOST_KEYS } from './hpc-bridge-host-keys'
import {
  BRIDGE_HOST_KEYS_FILE_ENV,
  BRIDGE_KEY_FILE_ENV,
  BRIDGE_USER_ENV,
  devBridgeKeyProvider,
  hostKeyFingerprint,
  hostKeyTable,
  parseHostKeyPin,
  pinnedHostKeys
} from './hpc-bridge-keys'
import { bridgeRecordFile, readBridgeRecord } from './hpc-bridge-record'
import {
  chat,
  keyLine,
  type KeyPair,
  type LoginNode,
  type ModelServer,
  newKeyPair,
  startLoginNode,
  startModelServer
} from './hpc-bridge.test-helper'
import { applyMainPolicies } from './main-policy'
import { managedModels } from './model-policy'
import { installIpcPolicyGuard, setMainPolicySeams } from './policy-seams'
import { AthenaToolPrefs, type CliResult } from './tool-prefs'

const LOGIN_HOST = '127.0.0.1'
const TARGET_HOST = 'model-node.test'
const TARGET_PORT = 9931
const USER = 'researcher1'
const QWEN_ID = 'qwen-3.8-27B-GGUF'
const QWEN_NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'

// Short intervals: a drop is retried in tens of milliseconds and a silent link is noticed in well under a second.
const FAST = {
  applyDebounceMs: 10,
  backoffMs: [20, 40, 80],
  hostKeyRetryMs: 60_000,
  keepaliveCountMax: 2,
  keepaliveIntervalMs: 80
}

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

let home: string
let athenaDir: string
let model: ModelServer
let login: LoginNode
let userKey: KeyPair
let bridges: HpcBridge[]

const document = (
  options: {
    feature?: 'off' | 'on'
    loginPort?: number
    managed?: string
    switchOn?: boolean
    targetPort?: number
  } = {}
): Record<string, unknown> => ({
  ...bundled,
  features: { ...(bundled.features as object), F05: options.feature ?? 'on' },
  local_models: {
    enabled: options.switchOn ?? true,
    login_host: LOGIN_HOST,
    login_port: options.loginPort ?? login.port,
    models: { [QWEN_ID]: { name: QWEN_NAME } },
    target_host: TARGET_HOST,
    target_port: options.targetPort ?? TARGET_PORT
  },
  managed: { ...(bundled.managed as object), features: options.managed ?? 'enforce' },
  models: {
    allowed: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { id: QWEN_ID, label: 'Qwen 3.8 27B (local)', provider: 'bridge' }
    ],
    default: 'gpt-6-luna'
  }
})

/** The stand-in's host key, pinned as a key line (as the build's table will pin the real one). */
const pins = () => ({ [`${LOGIN_HOST}:${login.port}`]: [keyLine(login.hostKey.public)] })

interface Harness {
  apply: ReturnType<typeof vi.fn>
  bridge: HpcBridge
  config: { current: Record<string, unknown> }
  log: string[]
  records: number
  statuses: HpcBridgeStatus[]
}

function harness(options: Partial<HpcBridgeOptions> & { config?: Record<string, unknown> } = {}): Harness {
  const { config: initial, ...rest } = options
  const config = { current: initial ?? document() }
  const log: string[] = []
  const statuses: HpcBridgeStatus[] = []
  const apply = vi.fn(async () => true)

  const made: Harness = { apply, bridge: undefined as never, config, log, records: 0, statuses }

  made.bridge = new HpcBridge({
    applyConfig: apply,
    athenaDir,
    hostKeys: pins(),
    keyProvider: () => ({ privateKey: userKey.private, username: USER }),
    log: line => log.push(line),
    onRecord: () => {
      made.records += 1
    },
    onStatus: status => statuses.push(status),
    snapshot: () => ({ config: config.current }),
    timings: FAST,
    ...rest
  })
  bridges.push(made.bridge)

  return made
}

const states = (h: Harness) =>
  h.statuses.map(status => (status.reason ? `${status.state}:${status.reason}` : status.state))

const connected = (h: Harness) => vi.waitFor(() => expect(h.bridge.status().state).toBe('connected'), { timeout: 5000 })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-hpc-bridge-'))
  athenaDir = path.join(home, 'hermes', 'athena')
  mkdirSync(athenaDir, { recursive: true })
  userKey = newKeyPair()
  model = await startModelServer()
  login = await startLoginNode({
    authorizedKey: userKey.public,
    route: (host, port) => (host === TARGET_HOST && port === TARGET_PORT ? model.port : null)
  })
  bridges = []
})

afterEach(async () => {
  for (const bridge of bridges) {
    bridge.stop()
  }

  setMainPolicySeams(null)
  await login.close()
  await model.close()
  rmSync(home, { force: true, recursive: true })
})

describe('what the client config asks for', () => {
  test('the hosts of local_models, with port 22 for the login host unless it names one', () => {
    expect(
      bridgeTarget({ local_models: { login_host: ' login5.test ', target_host: 'node.test', target_port: 9931 } })
    ).toEqual({
      loginHost: 'login5.test',
      loginPort: 22,
      targetHost: 'node.test',
      targetPort: 9931
    })
    expect(bridgeTarget(document({ loginPort: 2222 }))).toMatchObject({ loginPort: 2222 })

    for (const section of [
      undefined,
      {},
      { login_host: 'a', target_host: 'b' },
      { login_host: 'a', target_port: 1 },
      { target_host: 'b', target_port: 1 },
      { login_host: 'a', login_port: 0, target_host: 'b', target_port: 1 },
      { login_host: 'a', target_host: 'b', target_port: 70_000 },
      { login_host: 'a', target_host: 'b', target_port: '9931' }
    ]) {
      expect(bridgeTarget({ local_models: section })).toBeNull()
    }
  })

  test('wanted only with row F05 on, the switch on and the hosts named; never in a stock build', () => {
    expect(bridgeOffReason({ config: document() })).toBeNull()
    expect(bridgeOffReason({ config: document({ feature: 'off' }) })).toBe('feature_off')
    expect(bridgeOffReason({ config: { ...document(), features: {} } })).toBe('feature_off')
    expect(bridgeOffReason({ config: document({ switchOn: false }) })).toBe('switch_off')
    expect(bridgeOffReason({ config: { ...document(), local_models: { enabled: true } } })).toBe('not_configured')
    expect(bridgeOffReason({ config: document(), variant: 'stock' })).toBe('feature_off')
    expect(bridgeOffReason(null)).toBe('feature_off')
    // The master switch does not turn the row on: a disabled row needs its own flag, in every mode.
    expect(bridgeOffReason({ config: document({ feature: 'off', managed: 'off' }) })).toBe('feature_off')
  })
})

describe('the forward', () => {
  test('with a key the login node accepts, a request to the recorded address reaches the model server', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)

    const record = readBridgeRecord(athenaDir)
    expect(record).toMatchObject({ address: '127.0.0.1', pid: process.pid })
    expect(h.bridge.status()).toMatchObject({ port: record!.port, state: 'connected' })
    expect(states(h)).toEqual(['connecting', 'connected'])

    // What hermes is pinned to: http://<address>:<port>/v1, plain chat completions under the server's name.
    const answer = await chat(record!.port, QWEN_NAME)
    expect(answer).toMatchObject({ body: { choices: [{ message: { content: 'from the model node' } }] }, status: 200 })
    expect(model.requests).toEqual([
      { body: expect.objectContaining({ model: QWEN_NAME }), method: 'POST', path: '/v1/chat/completions' }
    ])

    // Signed in once, as the user, with the key and nothing else; the forward asked for the config's model server.
    expect(login.connections).toBe(1)
    expect(new Set(login.auth.map(attempt => `${attempt.method}:${attempt.username}`))).toEqual(
      new Set([`publickey:${USER}`])
    )
    // Two forwards to the config's model server, and to nothing else: the check after signing in (F05 slice 12:
    // each server is asked for once before its models are offered) and the request.
    expect(login.forwards).toEqual([
      { host: TARGET_HOST, port: TARGET_PORT },
      { host: TARGET_HOST, port: TARGET_PORT }
    ])

    // The record's change is told to main (which re-reads it) and to hermes (`athena config apply`), once.
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1))
    expect(h.records).toBe(1)
  })

  test('several requests at once each get their own channel', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)

    const answers = await Promise.all(Array.from({ length: 8 }, () => chat(h.bridge.localPort!, QWEN_NAME)))

    expect(answers.map(answer => answer.status)).toEqual(Array(8).fill(200))
    expect(model.requests).toHaveLength(8)
    expect(login.connections).toBe(1)
  })

  test('the forward listens on loopback only', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)
    const port = h.bridge.localPort!

    expect(JSON.parse(readFileSync(bridgeRecordFile(athenaDir), 'utf8')).address).toBe('127.0.0.1')

    // Every other address of this machine refuses the port.
    const others = Object.values(networkInterfaces())
      .flat()
      .filter(address => address && !address.internal && address.family === 'IPv4')
      .map(address => address!.address)

    for (const address of [...others, '::1']) {
      const outcome = await new Promise<string>(resolve => {
        const socket = connect({ host: address, port })
        socket.setTimeout(1500, () => {
          socket.destroy()
          resolve('timeout')
        })
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'))
      })

      expect(`${address} ${outcome}`).not.toBe(`${address} connected`)
    }
  })

  test('a model server the login node cannot reach fails the request, not the bridge', async () => {
    const h = harness({ config: document({ targetPort: 9932 }) })
    h.bridge.reconcile()
    await connected(h)

    await expect(chat(h.bridge.localPort!, QWEN_NAME)).rejects.toThrow()
    expect(h.bridge.status().state).toBe('connected')
    // Asked for after signing in (and again later, while it is down): only ever the config's model server.
    expect(login.forwards.length).toBeGreaterThan(0)
    expect(new Set(login.forwards.map(forward => `${forward.host}:${forward.port}`))).toEqual(
      new Set([`${TARGET_HOST}:9932`])
    )
  })
})

describe('the pinned host key', () => {
  test('another host key stops the connection before any authentication is sent', async () => {
    const other = newKeyPair()

    for (const pin of [keyLine(other.public), `SHA256:${'A'.repeat(43)}`]) {
      login.connections = 0
      const h = harness({ hostKeys: { [`${LOGIN_HOST}:${login.port}`]: [pin] } })
      h.bridge.reconcile()
      await vi.waitFor(() => expect(h.bridge.status()).toMatchObject({ reason: 'host_key_mismatch', state: 'down' }))
      await pause(100)

      // The node was reached, and never saw a user name or a key.
      expect(login.connections).toBe(1)
      expect(login.auth).toEqual([])
      expect(readBridgeRecord(athenaDir)).toBeNull()
      expect(h.apply).not.toHaveBeenCalled()
      expect(h.log.join('\n')).toMatch(/answered with host key SHA256:\S+, which is not pinned in this build; refused/)
      // Not asked again within moments: the next try is a minute away.
      expect(login.connections).toBe(1)
      h.bridge.stop()
    }
  })

  test('a fingerprint pin of the right key is accepted too', async () => {
    const blob = Buffer.from(keyLine(login.hostKey.public).split(' ')[1], 'base64')
    const h = harness({ hostKeys: { [LOGIN_HOST]: [hostKeyFingerprint(blob)] } })
    h.bridge.reconcile()

    await connected(h)
  })

  test('a host the build does not pin is never contacted: host_key_unknown', async () => {
    for (const hostKeys of [
      {},
      { [LOGIN_HOST]: [] },
      { [LOGIN_HOST]: ['not a key'] },
      { 'another.host': pins()[`${LOGIN_HOST}:${login.port}`] }
    ]) {
      const h = harness({ hostKeys })
      h.bridge.reconcile()
      await vi.waitFor(() => expect(h.bridge.status().state).toBe('host_key_unknown'))
      await pause(50)

      expect(login.connections).toBe(0)
      expect(h.bridge.localPort).toBeNull()
      h.bridge.stop()
    }
  })

  test('the build pins no key for the real login host yet: the placeholder is an empty list', () => {
    expect(HPC_BRIDGE_HOST_KEYS).toEqual({ 'login5.ccm.sickkids.ca': [] })
    expect(pinnedHostKeys(HPC_BRIDGE_HOST_KEYS, 'login5.ccm.sickkids.ca', 22).fingerprints.size).toBe(0)
  })

  test('pins: key lines and fingerprints, per host and per host:port', () => {
    const line = keyLine(login.hostKey.public)
    const fingerprint = hostKeyFingerprint(Buffer.from(line.split(' ')[1], 'base64'))

    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(parseHostKeyPin(`${line} a comment`)).toEqual({ fingerprint, type: 'ssh-ed25519' })
    expect(parseHostKeyPin(fingerprint)).toEqual({ fingerprint, type: null })

    for (const bad of [
      '',
      'ssh-ed25519',
      'ssh-rsa AAAA',
      line.replace('ssh-ed25519', 'ssh-rsa'),
      'SHA256:short',
      'MD5:aa:bb'
    ]) {
      expect(parseHostKeyPin(bad)).toBeNull()
    }

    const table = { 'login.test': [line], 'login.test:2222': [fingerprint, 'junk'] }

    // A key line says its type, so the host is asked for that key; a bare fingerprint cannot.
    expect(pinnedHostKeys(table, 'Login.Test', 22)).toEqual({
      algorithms: ['ssh-ed25519'],
      fingerprints: new Set([fingerprint])
    })
    expect(pinnedHostKeys(table, 'login.test', 2222)).toEqual({ fingerprints: new Set([fingerprint]) })
    expect(pinnedHostKeys(table, 'other.test', 22).fingerprints.size).toBe(0)
  })
})

describe('the key', () => {
  test('with no key nothing connects: no_key', async () => {
    const h = harness({ keyProvider: () => null })
    h.bridge.reconcile()
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('no_key'))
    await pause(50)

    expect(login.connections).toBe(0)
    expect(h.bridge.localPort).toBeNull()
    expect(readBridgeRecord(athenaDir)).toBeNull()
  })

  test('once a key is there, connect() opens the bridge (what the key setup calls)', async () => {
    let key: null | { privateKey: string; username: string } = null
    const h = harness({ keyProvider: async () => key })
    h.bridge.reconcile()
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('no_key'))

    key = { privateKey: userKey.private, username: USER }
    expect(await h.bridge.connect()).toMatchObject({ state: 'connecting' })
    await connected(h)
  })

  test('a key the login node does not accept: auth_failed, and it is not tried again by itself', async () => {
    const h = harness({ keyProvider: () => ({ privateKey: newKeyPair().private, username: USER }) })
    h.bridge.reconcile()
    await vi.waitFor(() => expect(h.bridge.status()).toMatchObject({ reason: 'auth_failed', state: 'down' }))
    await pause(300)

    expect(login.connections).toBe(1)
    expect(readBridgeRecord(athenaDir)).toBeNull()

    // A wake does not hammer the login host either; an explicit connect tries once more.
    h.bridge.kick({ force: true })
    await pause(100)
    expect(login.connections).toBe(1)
    await h.bridge.connect()
    await vi.waitFor(() => expect(login.connections).toBe(2))
  })

  test('a key that cannot be parsed: no_key (key_unreadable), nothing sent', async () => {
    const h = harness({ keyProvider: () => ({ privateKey: 'not a private key', username: USER }) })
    h.bridge.reconcile()
    await vi.waitFor(() => expect(h.bridge.status()).toMatchObject({ reason: 'key_unreadable', state: 'no_key' }))

    expect(login.connections).toBe(0)
  })

  test('the development key source is honoured only where dev overrides are', () => {
    const file = path.join(home, 'id_dev')
    writeFileSync(file, userKey.private)
    const env = { [BRIDGE_KEY_FILE_ENV]: file, [BRIDGE_USER_ENV]: USER }

    expect(devBridgeKeyProvider(env, { allowed: true })()).toEqual({
      privateKey: Buffer.from(userKey.private),
      username: USER
    })
    // A managed release, or a launch without ATHENA_DEV_OVERRIDES=1: no key, whatever the environment says.
    expect(devBridgeKeyProvider(env, { allowed: false })()).toBeNull()
    expect(devBridgeKeyProvider({ [BRIDGE_KEY_FILE_ENV]: file }, { allowed: true })()).toBeNull()
    expect(
      devBridgeKeyProvider({ ...env, [BRIDGE_KEY_FILE_ENV]: path.join(home, 'missing') }, { allowed: true })()
    ).toBeNull()
  })

  test('development host keys are merged over the build table only where dev overrides are', () => {
    const file = path.join(home, 'host-keys.json')
    const line = keyLine(login.hostKey.public)
    writeFileSync(file, JSON.stringify({ 'Stand-In.test:2222': [line, 7], broken: 'x' }))
    const env = { [BRIDGE_HOST_KEYS_FILE_ENV]: file }

    expect(hostKeyTable(env, { allowed: true })).toEqual({ ...HPC_BRIDGE_HOST_KEYS, 'stand-in.test:2222': [line] })
    expect(hostKeyTable(env, { allowed: false })).toBe(HPC_BRIDGE_HOST_KEYS)
    writeFileSync(file, '[]')
    expect(hostKeyTable(env, { allowed: true })).toBe(HPC_BRIDGE_HOST_KEYS)
  })
})

describe('a lost connection', () => {
  test('the record is absent while the bridge is down, and the bridge is back by itself', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)
    const port = h.bridge.localPort
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1))

    await login.goAway()
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('down'))
    // Removed with the connection, not at the next retry.
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(h.bridge.status().port).toBeUndefined()
    await expect(chat(port!, QWEN_NAME)).rejects.toThrow()
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(2))

    // Still away after several retries: still down, still no record.
    await pause(400)
    expect(h.bridge.status().state).toBe('down')
    expect(readBridgeRecord(athenaDir)).toBeNull()

    const back = Date.now()
    await login.listen()
    await connected(h)

    // Within one backoff step (80 ms here; 15 s in the app) and a handshake of the login host answering again.
    expect(Date.now() - back).toBeLessThan(2000)
    expect(readBridgeRecord(athenaDir)).toMatchObject({ pid: process.pid, port })
    expect((await chat(port!, QWEN_NAME)).status).toBe(200)
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(3))
    // Down with the reason of the latest failure (the cut, then a login host that does not answer), then back.
    expect(states(h)).toEqual(['connecting', 'connected', 'down:connection_lost', 'down:unreachable', 'connected'])
  })

  test('a cut connection is replaced at once when the login node still answers', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)

    const cut = Date.now()
    login.drop()
    await vi.waitFor(() => expect(login.connections).toBe(2))
    await connected(h)

    expect(Date.now() - cut).toBeLessThan(2000)
    expect(states(h)).toEqual(['connecting', 'connected', 'down:connection_lost', 'connected'])
  })

  test('a link that died silently is noticed by the keepalives', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)

    login.stall()
    await vi.waitFor(() => expect(states(h)).toContain('down:timeout'), { timeout: 5000 })
    await connected(h)

    expect(login.connections).toBe(2)
  })

  test('the timings the app runs with keep recovery within 30 seconds', () => {
    const { backoffMs, keepaliveCountMax, keepaliveIntervalMs, readyTimeoutMs } = BRIDGE_TIMINGS
    const longestWait = Math.max(...backoffMs)

    // A dead link is noticed, the first retry starts and a handshake completes: well inside 30 s.
    expect(keepaliveIntervalMs * keepaliveCountMax + backoffMs[0] + readyTimeoutMs).toBeLessThan(30_000)
    // The network returns just after an attempt began: that attempt times out, one wait, the next one connects.
    expect(readyTimeoutMs + longestWait).toBeLessThan(30_000)
    expect(backoffMs.at(-1)).toBe(longestWait)
  })

  test('a wake from sleep reconnects at once, on the same port', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)
    const port = h.bridge.localPort

    h.bridge.kick({ force: true })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    await vi.waitFor(() => expect(login.connections).toBe(2))
    await connected(h)
    expect(h.bridge.localPort).toBe(port)

    // An unlock, or the network coming back, leaves a live connection alone.
    h.bridge.kick()
    await pause(100)
    expect(login.connections).toBe(2)
  })
})

describe('the local port', () => {
  test('chosen once, remembered beside the Profile, and used again by the next launch', async () => {
    const first = harness()
    first.bridge.reconcile()
    await connected(first)
    const port = first.bridge.localPort!

    expect(readStoredPort(athenaDir)).toBe(port)
    expect(JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), 'utf8'))).toEqual({ port })
    first.bridge.stop()
    // The record goes with the bridge; the port is remembered.
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(readStoredPort(athenaDir)).toBe(port)

    const second = harness()
    second.bridge.reconcile()
    await connected(second)
    expect(second.bridge.localPort).toBe(port)
    expect(readBridgeRecord(athenaDir)?.port).toBe(port)
  })

  test('when the remembered port is taken, another one is used and remembered', async () => {
    const squatter = createServer()
    await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve))
    const taken = (squatter.address() as AddressInfo).port
    writeFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), JSON.stringify({ port: taken }))

    try {
      const h = harness()
      h.bridge.reconcile()
      await connected(h)

      expect(h.bridge.localPort).not.toBe(taken)
      expect(readStoredPort(athenaDir)).toBe(h.bridge.localPort)
      expect((await chat(h.bridge.localPort!, QWEN_NAME)).status).toBe(200)
    } finally {
      await new Promise(resolve => squatter.close(resolve))
    }
  })
})

describe('following the client config', () => {
  test('with the feature row off, or the switch off, nothing is attempted', async () => {
    for (const [config, reason] of [
      [document({ feature: 'off' }), 'feature_off'],
      [document({ switchOn: false }), 'switch_off']
    ] as const) {
      const h = harness({ config })
      h.bridge.reconcile()
      expect(await h.bridge.connect()).toMatchObject({ reason, state: 'off' })
      h.bridge.kick({ force: true })
      await pause(100)

      expect(h.bridge.status()).toMatchObject({ reason, state: 'off' })
      expect(h.bridge.localPort).toBeNull()
    }

    expect(login.connections).toBe(0)
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(readStoredPort(athenaDir)).toBeNull()
  })

  test('the switch going off closes the bridge and removes the record; back on, it reconnects', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)
    const port = h.bridge.localPort!
    // The apply for the record being written has run (it is debounced; a removal right behind it would share it).
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1))

    h.config.current = document({ switchOn: false })
    h.bridge.reconcile()

    expect(h.bridge.status()).toMatchObject({ reason: 'switch_off', state: 'off' })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    await expect(chat(port, QWEN_NAME)).rejects.toThrow()
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(2))

    h.config.current = document({ feature: 'off' })
    h.bridge.reconcile()
    expect(h.bridge.status()).toMatchObject({ reason: 'feature_off', state: 'off' })

    h.config.current = document()
    h.bridge.reconcile()
    await connected(h)
    expect(h.bridge.localPort).toBe(port)
    expect(login.connections).toBe(2)
  })

  test('the same config again changes nothing; another model server restarts the connection', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)

    h.config.current = document()
    h.bridge.reconcile()
    await pause(50)
    expect(login.connections).toBe(1)

    h.config.current = document({ targetPort: 9932 })
    h.bridge.reconcile()
    await vi.waitFor(() => expect(login.connections).toBe(2))
    await connected(h)
    await expect(chat(h.bridge.localPort!, QWEN_NAME)).rejects.toThrow()
    expect(login.forwards.at(-1)).toEqual({ host: TARGET_HOST, port: 9932 })
  })

  test('disconnect closes it and keeps it closed; connect opens it again', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)

    expect(h.bridge.disconnect()).toMatchObject({ reason: 'disconnected', state: 'off' })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    h.bridge.reconcile()
    h.bridge.kick({ force: true })
    await pause(100)
    expect(login.connections).toBe(1)

    await h.bridge.connect()
    await connected(h)
    expect(login.connections).toBe(2)
  })

  test('stop (the app quits) removes the record at once and applies', async () => {
    const h = harness()
    h.bridge.reconcile()
    await connected(h)
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1))

    h.bridge.stop()

    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(h.bridge.localPort).toBeNull()
    expect(h.apply).toHaveBeenCalledTimes(2)
    // Stopped for good: a late snapshot starts nothing.
    h.bridge.reconcile()
    await h.bridge.connect()
    await pause(100)
    expect(login.connections).toBe(1)
  })
})

describe('athena config apply', () => {
  test('runs through the CLI after the record is written and after it is removed', async () => {
    const runs: { args: string[]; file: string; home: string | undefined }[] = []

    const prefs = new AthenaToolPrefs({
      env: { ATHENA_CLI: '/opt/athena/bin/athena', PATH: '/usr/bin', VIRTUAL_ENV: '/elsewhere' },
      hermesHome: path.dirname(athenaDir),
      isExecutable: file => file === '/opt/athena/bin/athena',
      log: () => {},
      run: async (file, args, env): Promise<CliResult> => {
        runs.push({ args, file, home: env.HERMES_HOME })
        expect(env.VIRTUAL_ENV).toBeUndefined()

        return { code: 0, stderr: '', stdout: 'applied\n' }
      }
    })

    const h = harness({ applyConfig: () => prefs.applyConfig() })
    h.bridge.reconcile()
    await connected(h)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    h.bridge.disconnect()
    await vi.waitFor(() => expect(runs).toHaveLength(2))

    expect(runs).toEqual(
      Array(2).fill({ args: ['config', 'apply'], file: '/opt/athena/bin/athena', home: path.dirname(athenaDir) })
    )
  })

  test('with no CLI nothing runs (the Shipper applies at its next sync), and a failing one does not stop the bridge', async () => {
    const log: string[] = []

    const none = new AthenaToolPrefs({
      env: {},
      hermesHome: home,
      isExecutable: () => false,
      log: line => log.push(line)
    })

    expect(await none.applyConfig()).toBe(false)
    expect(log.join('\n')).toContain('no athena CLI')

    const h = harness({ applyConfig: () => Promise.reject(new Error('exit 3')) })
    h.bridge.reconcile()
    await connected(h)
    await vi.waitFor(() => expect(h.log.join('\n')).toContain('athena config apply failed'))
    expect(h.bridge.status().state).toBe('connected')
  })
})

describe('installed in main', () => {
  interface FakeIpc {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => void
    handlers: Map<string, (...args: unknown[]) => unknown>
    removeHandler: (channel: string) => void
  }

  function fakeIpc(): FakeIpc {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()

    const ipc: FakeIpc = {
      handle: (channel, listener) => void handlers.set(channel, listener),
      handlers,
      removeHandler: channel => void handlers.delete(channel)
    }

    Object.assign(ipc, { on: () => ipc, removeListener: () => ipc })

    // As main.ts does first of all (ipc-guard-install.ts): a channel a feature row lists follows that row.
    installIpcPolicyGuard(ipc as never, isPolicyIpcChannel)

    return ipc
  }

  function install(config: Record<string, unknown>, extra: { keyProvider?: HpcBridgeOptions['keyProvider'] } = {}) {
    const sent: [string, HpcBridgeStatus][] = []
    const listeners = new Map<string, () => void>()
    const power = new Map<string, () => void>()
    const ipc = fakeIpc()
    const state = { config }

    const source = new AthenaClientConfig({
      athenaDir,
      bundledDefault: state.config,
      onChange: snapshot => applyMainPolicies(snapshot)
    })

    // The source reads its bundled default once; a config change is a new source, as a new snapshot is in the app.
    const live = { source }

    const setConfig = (next: Record<string, unknown>) => {
      live.source = new AthenaClientConfig({
        athenaDir,
        bundledDefault: next,
        onChange: snapshot => applyMainPolicies(snapshot)
      })
      applyMainPolicies(live.source.snapshot())
    }

    applyMainPolicies(source.snapshot())

    const bridge = installAthenaHpcBridge({
      allWindows: () => [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (channel: string, status: HpcBridgeStatus) => sent.push([channel, status])
          }
        } as never
      ],
      app: { on: (event, listener) => listeners.set(event, listener), whenReady: () => Promise.resolve() },
      applyConfig: async () => true,
      athenaDir,
      clientConfig: () => live.source,
      hostKeys: pins(),
      installStamp: { brand: 'athena' },
      ipcMain: ipc as never,
      keyProvider: extra.keyProvider ?? (() => ({ privateKey: userKey.private, username: USER })),
      log: () => {},
      powerMonitor: () => ({ on: (event, listener) => power.set(event, listener) }),
      timings: FAST
    })

    bridges.push(bridge)

    return {
      bridge,
      ipc,
      listeners,
      power,
      sent,
      setConfig,
      snapshot: (): ClientConfigSnapshot => live.source.snapshot()
    }
  }

  const invoke = (ipc: FakeIpc, channel: string) => {
    const handler = ipc.handlers.get(channel)

    if (!handler) {
      throw new Error(`No handler registered for '${channel}'`)
    }

    return handler({})
  }

  test('the row on: it connects, every window hears the status, and the snapshot carries the bridge', async () => {
    const app = install(document())
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('connected'), { timeout: 5000 })
    const port = app.bridge.status().port!

    expect(app.sent.map(([channel, status]) => [channel, status.state])).toEqual([
      [HPC_BRIDGE_CHANNELS.changed, 'connecting'],
      [HPC_BRIDGE_CHANNELS.changed, 'connected']
    ])
    // Main re-read the record at once: the pickers and the model gate list the local model without waiting a poll.
    expect(app.snapshot().hpcBridge).toMatchObject({ address: '127.0.0.1', port })
    const models = managedModels(app.snapshot().config, { bridgeUp: Boolean(app.snapshot().hpcBridge) })
    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-luna', QWEN_NAME])

    expect(invoke(app.ipc, HPC_BRIDGE_CHANNELS.status)).toMatchObject({ port, state: 'connected' })
    expect(invoke(app.ipc, HPC_BRIDGE_CHANNELS.disconnect)).toMatchObject({ reason: 'disconnected', state: 'off' })
    expect(app.snapshot().hpcBridge).toBeUndefined()
    expect(await invoke(app.ipc, HPC_BRIDGE_CHANNELS.connect)).toMatchObject({ state: 'connecting' })
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('connected'), { timeout: 5000 })
  })

  test('the row off: no connection is attempted and the IPC calls are refused', async () => {
    const app = install(document({ feature: 'off' }))
    await pause(100)

    expect(app.bridge.status()).toMatchObject({ reason: 'feature_off', state: 'off' })
    expect(login.connections).toBe(0)
    expect([...app.ipc.handlers.keys()]).toEqual([])

    for (const channel of [HPC_BRIDGE_CHANNELS.status, HPC_BRIDGE_CHANNELS.connect, HPC_BRIDGE_CHANNELS.disconnect]) {
      expect(() => invoke(app.ipc, channel)).toThrow(/No handler registered/)
    }

    // The admin turns the row on: the channels register and the bridge opens with the next snapshot.
    app.setConfig(document())
    expect([...app.ipc.handlers.keys()].sort()).toEqual(
      [HPC_BRIDGE_CHANNELS.connect, HPC_BRIDGE_CHANNELS.disconnect, HPC_BRIDGE_CHANNELS.status].sort()
    )
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('connected'), { timeout: 5000 })

    // And off again: closed, the record gone, the channels unregistered.
    app.setConfig(document({ feature: 'off' }))
    expect(app.bridge.status()).toMatchObject({ reason: 'feature_off', state: 'off' })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect([...app.ipc.handlers.keys()]).toEqual([])
    expect(login.connections).toBe(1)
  })

  test('under managed.features: report the channels are registered, and each call still asks the row', async () => {
    const app = install(document({ feature: 'off', managed: 'report' }))
    await pause(100)

    expect(login.connections).toBe(0)

    for (const channel of [HPC_BRIDGE_CHANNELS.status, HPC_BRIDGE_CHANNELS.connect, HPC_BRIDGE_CHANNELS.disconnect]) {
      expect(() => invoke(app.ipc, channel)).toThrow(`refused_by_policy: ipc ${channel}`)
    }

    expect(login.connections).toBe(0)
  })

  test('quit removes the record; a wake reconnects', async () => {
    const app = install(document())
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('connected'), { timeout: 5000 })
    await pause(0) // whenReady resolved: the power monitor is attached

    app.power.get('resume')!()
    await vi.waitFor(() => expect(login.connections).toBe(2))
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('connected'), { timeout: 5000 })
    app.power.get('unlock-screen')!()
    await pause(100)
    expect(login.connections).toBe(2)

    app.listeners.get('will-quit')!()
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(app.bridge.status().state).toBe('off')
  })

  test('with no key installed the status is no_key and nothing connects', async () => {
    const app = install(document(), { keyProvider: () => null })
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('no_key'))

    expect(invoke(app.ipc, HPC_BRIDGE_CHANNELS.status)).toMatchObject({ state: 'no_key' })
    expect(login.connections).toBe(0)
  })
})
