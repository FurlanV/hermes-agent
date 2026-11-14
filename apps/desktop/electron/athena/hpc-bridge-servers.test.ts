// F05 slice 12: more than one model server through the HPC bridge, one of them with an API key.
//
// One SSH connection to the stand-in login node, one forward per model server of the config, each on its own kept
// loopback port. One server being down (from the start, or later) leaves the other's forward, record entry and
// models as they are. The model gate lists and accepts each local model only on its own server's provider, and only
// while that server's forward is up. The key never reaches the bridge's log, its status, the bridge record, the
// port file, a client-config snapshot, `desktop-status.json` or a recorded policy decision.
// Everything runs on loopback (hpc-bridge.test-helper.ts); no real host is contacted.
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { AthenaClientConfig, withoutModelServerKeys } from './client-config'
import {
  BRIDGE_PORT_FILE,
  bridgeOffReason,
  bridgePlan,
  HpcBridge,
  type HpcBridgeOptions,
  type HpcBridgeStatus,
  readStoredPort,
  readStoredPorts
} from './hpc-bridge'
import { bridgePorts, readBridgeRecord } from './hpc-bridge-record'
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
import { applyMainPolicies, configureMainPolicies } from './main-policy'
import {
  ATHENA_BRIDGE_PROVIDER,
  ATHENA_GATEWAY_PROVIDER,
  bridgeProviderFor,
  bridgeState,
  isAthenaProvider,
  isBridgeProvider,
  managedModels,
  managedPickerRows,
  modelUseDecision
} from './model-policy'
import { PolicyDecisionLog } from './policy-decisions'
import { refuseRestRequest, setMainPolicySeams } from './policy-seams'

const MARKER = 'sk-MARKER-model-server-key-7f3a9c'
const LOGIN_HOST = '127.0.0.1'
const USER = 'researcher1'
const QWEN_ID = 'qwen-3.8-27B-GGUF'
const QWEN_NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'
const DEEPSEEK = 'deepseek-v4f-moe'
const SERVER = 'hpc-llm'
const KEYED_PROVIDER = 'custom:athena-local-hpc-llm'
/** The default server and the keyed one, as the login node names them. */
const NODE = { host: 'model-node.test', port: 9931 }
const KEYED = { host: '172.20.22.0', port: 9071 }

const FAST = {
  applyDebounceMs: 10,
  backoffMs: [20, 40, 80],
  hostKeyRetryMs: 60_000,
  keepaliveCountMax: 2,
  keepaliveIntervalMs: 80,
  probeTimeoutMs: 1000
}

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

let home: string
let athenaDir: string
let node: ModelServer
let keyed: ModelServer
let login: LoginNode
let userKey: KeyPair
let bridges: HpcBridge[]
/** Model servers the login node cannot reach right now, by `host:port`. */
let unreachable: Set<string>

const document = (
  options: { key?: unknown; loginPort?: number; servers?: Record<string, unknown> } = {}
): Record<string, unknown> => ({
  ...bundled,
  features: { ...(bundled.features as object), F05: 'on' },
  local_models: {
    enabled: true,
    login_host: LOGIN_HOST,
    login_port: options.loginPort ?? login.port,
    models: { [DEEPSEEK]: { name: DEEPSEEK, server: SERVER }, [QWEN_ID]: { name: QWEN_NAME } },
    servers: options.servers ?? {
      [SERVER]: { ...KEYED, key: options.key === undefined ? { type: 'shared', value: MARKER } : options.key }
    },
    target_host: NODE.host,
    target_port: NODE.port
  },
  models: {
    allowed: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { id: QWEN_ID, label: 'Qwen 3.8 27B (local)', provider: 'bridge' },
      { id: DEEPSEEK, label: DEEPSEEK, provider: 'bridge', reasoning: { default: 'medium', levels: ['medium'] } }
    ],
    default: 'gpt-6-luna'
  }
})

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
    // The bridge is handed the document as it was signed, key and all: it must not let any of it out.
    snapshot: () => ({ config: config.current }),
    timings: FAST,
    ...rest
  })
  bridges.push(made.bridge)

  return made
}

const serverStates = (h: Harness) =>
  Object.fromEntries(Object.entries(h.bridge.status().servers ?? {}).map(([id, server]) => [id, server.state]))

/** Connected, and every server has been asked for. */
const settled = (h: Harness, expected: Record<string, string>) =>
  vi.waitFor(
    () => {
      expect(h.bridge.status().state).toBe('connected')
      expect(serverStates(h)).toEqual(expected)
    },
    { timeout: 5000 }
  )

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const key = (server: { host: string; port: number }) => `${server.host}:${server.port}`

/** Every file under the Profile's athena folder whose bytes contain `needle`. */
function filesHolding(needle: string, dir = athenaDir): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => readFileSync(file).includes(needle))
    .map(file => path.relative(athenaDir, file))
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-hpc-servers-'))
  athenaDir = path.join(home, 'hermes', 'athena')
  mkdirSync(athenaDir, { recursive: true })
  userKey = newKeyPair()
  node = await startModelServer('from the model node')
  keyed = await startModelServer('from the keyed server', { key: MARKER })
  unreachable = new Set()
  login = await startLoginNode({
    authorizedKey: userKey.public,
    route: (host, port) => {
      const target = `${host}:${port}`

      if (unreachable.has(target)) {
        return null
      }

      return target === key(NODE) ? node.port : target === key(KEYED) ? keyed.port : null
    }
  })
  bridges = []
})

afterEach(async () => {
  for (const bridge of bridges) {
    bridge.stop()
  }

  setMainPolicySeams(null)
  configureMainPolicies({})
  await login.close()
  await node.close()
  await keyed.close()
  rmSync(home, { force: true, recursive: true })
})

describe('what the client config asks for', () => {
  test('the login host, the default server and every usable entry of local_models.servers', () => {
    expect(bridgePlan(document({ loginPort: 2222 }))).toEqual({
      loginHost: LOGIN_HOST,
      loginPort: 2222,
      servers: [
        { host: NODE.host, id: 'default', port: NODE.port },
        { host: KEYED.host, id: SERVER, port: KEYED.port }
      ]
    })
    // The plan has no key in it: the bridge never needs one.
    expect(JSON.stringify(bridgePlan(document()))).not.toContain(MARKER)
  })

  test('a config for the one default server is the plan it was', () => {
    expect(
      bridgePlan({ local_models: { login_host: 'login5.test', target_host: 'node.test', target_port: 9931 } })
    ).toEqual({ loginHost: 'login5.test', loginPort: 22, servers: [{ host: 'node.test', id: 'default', port: 9931 }] })
  })

  test('servers alone are enough; an entry that is not a server is left out', () => {
    const section = {
      enabled: true,
      login_host: 'login5.test',
      servers: {
        '../escape': { host: 'x.test', port: 1 },
        'Not An Id': { host: 'x.test', port: 1 },
        default: { host: 'shadow.test', port: 1 },
        'no-host': { port: 1 },
        'no-port': { host: 'x.test' },
        'port-as-text': { host: 'x.test', port: '9071' },
        [SERVER]: KEYED
      }
    }

    expect(bridgePlan({ local_models: section })?.servers).toEqual([{ ...KEYED, id: SERVER }])
    expect(bridgeOffReason({ config: { ...document(), local_models: section } })).toBeNull()
    expect(bridgeOffReason({ config: { ...document(), local_models: { ...section, servers: {} } } })).toBe(
      'not_configured'
    )
  })
})

describe('one connection, one forward per model server', () => {
  test('each server answers on its own loopback port, under its own name, and only the keyed one sees the key', async () => {
    const h = harness()
    h.bridge.reconcile()
    await settled(h, { default: 'up', [SERVER]: 'up' })

    const status = h.bridge.status()
    const ports = { default: status.servers!.default.port!, keyed: status.servers![SERVER].port! }
    expect(ports.default).not.toBe(ports.keyed)
    // Slice 06's status fields are still there: `port` is the default server's forward.
    expect(status).toMatchObject({ port: ports.default, state: 'connected' })
    expect(h.bridge.localPort).toBe(ports.default)
    expect(h.bridge.localPortOf(SERVER)).toBe(ports.keyed)

    // The record lists both, and the default one again as `port`.
    const record = readBridgeRecord(athenaDir)
    expect(record).toMatchObject({ address: '127.0.0.1', pid: process.pid, port: ports.default })
    expect(bridgePorts(record)).toEqual({ default: ports.default, [SERVER]: ports.keyed })

    // What hermes does once managed scope pins a provider per server: the key goes to the keyed server only.
    expect(await chat(ports.default, QWEN_NAME)).toMatchObject({
      body: { choices: [{ message: { content: 'from the model node' } }] },
      status: 200
    })
    expect(await chat(ports.keyed, DEEPSEEK, '127.0.0.1', MARKER)).toMatchObject({
      body: { choices: [{ message: { content: 'from the keyed server' } }] },
      status: 200
    })
    expect(node.requests.map(request => (request.body as { model: string }).model)).toEqual([QWEN_NAME])
    expect(keyed.requests.map(request => (request.body as { model: string }).model)).toEqual([DEEPSEEK])
    expect(node.authorizations).toEqual(['Bearer no-key-required'])
    expect(keyed.authorizations).toEqual([`Bearer ${MARKER}`])
    // The forward adds nothing: without the key the keyed server still says no.
    expect((await chat(ports.keyed, DEEPSEEK)).status).toBe(401)

    // One SSH connection carried all of it, to the config's two servers and nowhere else.
    expect(login.connections).toBe(1)
    expect(new Set(login.forwards.map(key))).toEqual(new Set([key(NODE), key(KEYED)]))
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalled())
  })

  test('each port is chosen once and kept beside the Profile', async () => {
    const first = harness()
    first.bridge.reconcile()
    await settled(first, { default: 'up', [SERVER]: 'up' })
    const ports = { default: first.bridge.localPort!, [SERVER]: first.bridge.localPortOf(SERVER)! }

    expect(JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), 'utf8'))).toEqual({
      port: ports.default,
      servers: { [SERVER]: ports[SERVER] }
    })
    expect(readStoredPorts(athenaDir)).toEqual(ports)
    expect(readStoredPort(athenaDir)).toBe(ports.default)
    first.bridge.stop()
    expect(readBridgeRecord(athenaDir)).toBeNull()

    const second = harness()
    second.bridge.reconcile()
    await settled(second, { default: 'up', [SERVER]: 'up' })
    expect(bridgePorts(readBridgeRecord(athenaDir))).toEqual(ports)
  })

  test("when one server's remembered port is taken, that server gets another and the other keeps its own", async () => {
    const squatter = createServer()
    await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve))
    const taken = (squatter.address() as AddressInfo).port
    const first = harness()
    first.bridge.reconcile()
    await settled(first, { default: 'up', [SERVER]: 'up' })
    const kept = first.bridge.localPort!
    first.bridge.stop()
    writeFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), JSON.stringify({ port: kept, servers: { [SERVER]: taken } }))

    try {
      const h = harness()
      h.bridge.reconcile()
      await settled(h, { default: 'up', [SERVER]: 'up' })

      expect(h.bridge.localPort).toBe(kept)
      expect(h.bridge.localPortOf(SERVER)).not.toBe(taken)
      expect(readStoredPorts(athenaDir)).toEqual({ default: kept, [SERVER]: h.bridge.localPortOf(SERVER) })
      expect((await chat(h.bridge.localPortOf(SERVER)!, DEEPSEEK, '127.0.0.1', MARKER)).status).toBe(200)
    } finally {
      await new Promise(resolve => squatter.close(resolve))
    }
  })

  test('a config for the one default server behaves as it did: one forward, the port file as it was', async () => {
    const single = document({ servers: {} })
    const h = harness({ config: single })
    h.bridge.reconcile()
    await settled(h, { default: 'up' })

    expect(JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_PORT_FILE), 'utf8'))).toEqual({
      port: h.bridge.localPort
    })
    expect(readBridgeRecord(athenaDir)).toMatchObject({ port: h.bridge.localPort })
    expect((await chat(h.bridge.localPort!, QWEN_NAME)).status).toBe(200)
    expect(new Set(login.forwards.map(key))).toEqual(new Set([key(NODE)]))
  })
})

describe('one model server down', () => {
  test.each([
    ['the keyed server', KEYED, { default: 'up', [SERVER]: 'down' }],
    ['the default server', NODE, { default: 'down', [SERVER]: 'up' }]
  ])('%s down from the start: the other one works', async (_name, down, expected) => {
    unreachable.add(key(down))
    const h = harness()
    h.bridge.reconcile()
    await settled(h, expected)

    const status = h.bridge.status()
    const downId = down === KEYED ? SERVER : 'default'
    const upId = down === KEYED ? 'default' : SERVER
    expect(status.servers![downId]).toEqual({ reason: 'target_unreachable', state: 'down' })
    expect(status.servers![upId]).toEqual({ port: h.bridge.localPortOf(upId), state: 'up' })
    // `port` is the default server's forward: absent while that one is down.
    expect(status.port).toBe(down === NODE ? undefined : h.bridge.localPort)

    // The record lists the server that answers, and only it.
    const record = readBridgeRecord(athenaDir)
    expect(bridgePorts(record)).toEqual({ [upId]: h.bridge.localPortOf(upId) })
    expect(record && 'port' in record).toBe(down !== NODE)

    // The other server's model answers; nothing is forwarded for the one that is down.
    const answer =
      upId === SERVER
        ? await chat(h.bridge.localPortOf(SERVER)!, DEEPSEEK, '127.0.0.1', MARKER)
        : await chat(h.bridge.localPort!, QWEN_NAME)

    expect(answer.status).toBe(200)
    await expect(chat(h.bridge.localPortOf(downId)!, 'any-model')).rejects.toThrow()
    expect(login.connections).toBe(1)

    // And the model gate follows the record: the other server's model is listed, this one's is not.
    const models = managedModels(withoutModelServerKeys(h.config.current), bridgeState(record))
    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-luna', upId === SERVER ? DEEPSEEK : QWEN_NAME])
  })

  test('a server that comes back is found again by itself, and the record gains it', async () => {
    unreachable.add(key(KEYED))
    const h = harness()
    h.bridge.reconcile()
    await settled(h, { default: 'up', [SERVER]: 'down' })
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1))
    expect(Object.keys(bridgePorts(readBridgeRecord(athenaDir)))).toEqual(['default'])

    unreachable.delete(key(KEYED))
    await settled(h, { default: 'up', [SERVER]: 'up' })

    expect(bridgePorts(readBridgeRecord(athenaDir))).toEqual({
      default: h.bridge.localPort,
      [SERVER]: h.bridge.localPortOf(SERVER)
    })
    // Hermes is told again (`athena config apply`), on the same connection, and the default server never blinked.
    await vi.waitFor(() => expect(h.apply).toHaveBeenCalledTimes(2))
    expect(login.connections).toBe(1)
    expect(h.statuses.filter(status => status.state !== 'connected').map(status => status.state)).toEqual([
      'connecting'
    ])
    expect((await chat(h.bridge.localPortOf(SERVER)!, DEEPSEEK, '127.0.0.1', MARKER)).status).toBe(200)
  })

  test('a server that goes away while up: its request fails, it leaves the record, the other stays', async () => {
    const h = harness()
    h.bridge.reconcile()
    await settled(h, { default: 'up', [SERVER]: 'up' })
    const since = h.bridge.status().since

    unreachable.add(key(KEYED))
    await expect(chat(h.bridge.localPortOf(SERVER)!, DEEPSEEK, '127.0.0.1', MARKER)).rejects.toThrow()
    await settled(h, { default: 'up', [SERVER]: 'down' })

    expect(Object.keys(bridgePorts(readBridgeRecord(athenaDir)))).toEqual(['default'])
    expect((await chat(h.bridge.localPort!, QWEN_NAME)).status).toBe(200)
    expect(login.connections).toBe(1)
    // The bridge itself did not change state: `since` is when it connected.
    expect(h.bridge.status().since).toBe(since)
  })

  test('with every server down the bridge is connected, offers nothing, and writes no record', async () => {
    unreachable.add(key(KEYED)).add(key(NODE))
    const h = harness()
    h.bridge.reconcile()
    await settled(h, { default: 'down', [SERVER]: 'down' })

    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(h.bridge.status().port).toBeUndefined()
    expect(h.apply).not.toHaveBeenCalled()
  })

  test('the status says nothing of servers while the bridge is not connected', async () => {
    const h = harness()
    h.bridge.reconcile()
    await settled(h, { default: 'up', [SERVER]: 'up' })

    expect(h.bridge.disconnect()).toEqual({
      credential: 'key',
      reason: 'disconnected',
      since: expect.any(String),
      state: 'off'
    })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    await login.goAway()
    await h.bridge.connect()
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('down'))
    expect('servers' in h.bridge.status()).toBe(false)
  })

  test('a server added to the config is forwarded too, and one taken out loses its forward', async () => {
    const h = harness({ config: document({ servers: {} }) })
    h.bridge.reconcile()
    await settled(h, { default: 'up' })
    const port = h.bridge.localPort

    h.config.current = document()
    h.bridge.reconcile()
    await settled(h, { default: 'up', [SERVER]: 'up' })
    expect(h.bridge.localPort).toBe(port)
    const keyedPort = h.bridge.localPortOf(SERVER)!

    h.config.current = document({ servers: {} })
    h.bridge.reconcile()
    await settled(h, { default: 'up' })
    expect(h.bridge.localPortOf(SERVER)).toBeNull()
    await expect(chat(keyedPort, DEEPSEEK, '127.0.0.1', MARKER)).rejects.toThrow()
    expect(bridgePorts(readBridgeRecord(athenaDir))).toEqual({ default: port })
  })
})

describe('the key stays out of everything the bridge and main write', () => {
  test('no log line, no status, no record and no port file carries it', async () => {
    unreachable.add(key(KEYED))
    const h = harness()
    h.bridge.reconcile()
    await settled(h, { default: 'up', [SERVER]: 'down' })
    unreachable.delete(key(KEYED))
    await settled(h, { default: 'up', [SERVER]: 'up' })
    await chat(h.bridge.localPortOf(SERVER)!, DEEPSEEK, '127.0.0.1', MARKER)
    login.drop()
    await vi.waitFor(() => expect(h.statuses.some(status => status.state === 'down')).toBe(true))
    await settled(h, { default: 'up', [SERVER]: 'up' })
    await pause(50)

    expect(h.log.length).toBeGreaterThan(3)
    expect(h.log.join('\n')).not.toContain(MARKER)
    expect(JSON.stringify(h.statuses)).not.toContain(MARKER)
    expect(filesHolding(MARKER)).toEqual([])
    h.bridge.stop()
    expect(h.log.join('\n')).not.toContain(MARKER)
    expect(filesHolding(MARKER)).toEqual([])
  })

  test('main strips the key from the signed config before anything holds it', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const trusted: ReadonlyMap<string, KeyObject> = new Map([['test-kid', publicKey]])
    const oid = '00000000-0000-0000-0000-0000000000aa'
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Date.parse('2026-11-13T20:00:00Z')

    const payload = {
      ...document(),
      aud: 'athena-desktop',
      config_version: 120,
      expires_at: '2026-11-14T19:00:00Z',
      issued_at: '2026-11-13T19:00:00Z',
      role: 'researcher',
      schema_version: '1.0',
      sub: oid
    }

    const head = `${b64({ alg: 'EdDSA', kid: 'test-kid', typ: 'athena-client-config+jws' })}.${b64(payload)}`
    const token = `${head}.${sign(null, Buffer.from(head), privateKey).toString('base64url')}`
    // The signed file itself does hold the key (base64url-encoded): that is where the applier reads it.
    expect(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).toContain(MARKER)
    writeFileSync(path.join(athenaDir, 'client-config.jws'), token)
    writeFileSync(
      path.join(athenaDir, 'token.json'),
      JSON.stringify({ access_token: `${b64({ alg: 'none' })}.${b64({ oid })}.sig` })
    )

    const log: string[] = []
    const seen: unknown[] = []

    const source = new AthenaClientConfig({
      athenaDir,
      log: line => log.push(line),
      now: () => now,
      onChange: snapshot => seen.push(snapshot),
      trusted
    })

    const snapshot = source.snapshot()
    expect(snapshot).toMatchObject({ configVersion: 120, error: null, source: 'server' })
    // What every window, every policy and every later reader of the snapshot gets: the server, and that it has a
    // shared key, never the key.
    const servers = (snapshot.config.local_models as { servers: Record<string, unknown> }).servers
    expect(servers).toEqual({ [SERVER]: { ...KEYED, key: { type: 'shared' } } })
    expect(JSON.stringify(snapshot)).not.toContain(MARKER)

    // A change of snapshot (the bridge coming up) is logged and pushed: still nothing.
    writeFileSync(
      path.join(athenaDir, 'hpc-bridge.json'),
      JSON.stringify({ address: '127.0.0.1', pid: process.pid, servers: { [SERVER]: { port: 49732 } }, version: 2 })
    )
    source.refresh()
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toContain(MARKER)
    expect(log.join('\n')).not.toContain(MARKER)
    // On disk, only the signed file (encoded) knows it: not desktop-status.json, not the bridge record.
    expect(filesHolding(MARKER)).toEqual([])
    expect(readFileSync(path.join(athenaDir, 'desktop-status.json'), 'utf8')).not.toContain('local_models')
  })

  test('withoutModelServerKeys keeps the key type and drops the rest; other documents come back as they are', () => {
    const stripped = withoutModelServerKeys(document({ key: { extra: MARKER, type: 'per_user', value: MARKER } }))
    expect((stripped.local_models as { servers: Record<string, unknown> }).servers[SERVER]).toEqual({
      ...KEYED,
      key: { type: 'per_user' }
    })
    expect(JSON.stringify(withoutModelServerKeys(document({ key: MARKER })))).not.toContain(MARKER)
    const noKey = document({ servers: { [SERVER]: KEYED } })
    expect(withoutModelServerKeys(noKey)).toEqual(noKey)
    const single = { local_models: { enabled: true, target_host: 'a', target_port: 1 } }
    expect(withoutModelServerKeys(single)).toBe(single)
    expect(withoutModelServerKeys(bundled)).toBe(bundled)
  })

  test('a refused pick is recorded without the key', () => {
    const file = path.join(home, 'decisions.jsonl')
    configureMainPolicies({ decisions: new PolicyDecisionLog({ file }) })
    const config = withoutModelServerKeys(document())

    const setDefault = (model: string, provider: string) => ({
      body: { model, provider, scope: 'main' },
      method: 'POST',
      path: '/api/model/set'
    })

    // The keyed server is down: its model is refused and the refusal written to the decisions file.
    applyMainPolicies({ config, hpcBridge: { address: '127.0.0.1', connectedAt: null, port: 49731 } })
    expect(refuseRestRequest(setDefault(DEEPSEEK, KEYED_PROVIDER))).not.toBeNull()
    expect(refuseRestRequest(setDefault(QWEN_NAME, ATHENA_BRIDGE_PROVIDER))).toBeNull()

    const recorded = readFileSync(file, 'utf8')
    expect(recorded).toContain(DEEPSEEK)
    expect(recorded).not.toContain(MARKER)

    // Up: accepted on its own provider, and only there.
    applyMainPolicies({
      config,
      hpcBridge: { address: '127.0.0.1', connectedAt: null, port: 49731, servers: { default: 49731, [SERVER]: 49732 } }
    })
    expect(refuseRestRequest(setDefault(DEEPSEEK, KEYED_PROVIDER))).toBeNull()
    expect(refuseRestRequest(setDefault(DEEPSEEK, ATHENA_BRIDGE_PROVIDER))).not.toBeNull()
    expect(refuseRestRequest(setDefault(QWEN_NAME, KEYED_PROVIDER))).not.toBeNull()
    expect(refuseRestRequest(setDefault(DEEPSEEK, ATHENA_GATEWAY_PROVIDER))).not.toBeNull()
  })
})

describe('the model gate: each local model on its own server and its own provider', () => {
  const config = () => withoutModelServerKeys(document())
  const both = { bridgeUp: true, serversUp: ['default', SERVER] }

  test('one provider per model server', () => {
    expect(bridgeProviderFor('default')).toBe(ATHENA_BRIDGE_PROVIDER)
    expect(bridgeProviderFor(SERVER)).toBe(KEYED_PROVIDER)

    for (const provider of [ATHENA_BRIDGE_PROVIDER, 'athena-vllm', KEYED_PROVIDER, 'athena-local-hpc-llm']) {
      expect(isBridgeProvider(provider)).toBe(true)
      expect(isAthenaProvider(provider)).toBe(true)
    }

    expect(isBridgeProvider(ATHENA_GATEWAY_PROVIDER)).toBe(false)
    expect(isBridgeProvider('custom:athena-localhost')).toBe(false)
    expect(isAthenaProvider('openrouter')).toBe(false)
  })

  test('both servers up: each model on its own row, never the default', () => {
    const models = managedModels(config(), both)

    expect(models.visible.map(entry => [entry.id, entry.provider, entry.server])).toEqual([
      ['gpt-6-luna', ATHENA_GATEWAY_PROVIDER, undefined],
      [QWEN_NAME, ATHENA_BRIDGE_PROVIDER, 'default'],
      [DEEPSEEK, KEYED_PROVIDER, SERVER]
    ])
    expect(models.default).toBe('gpt-6-luna')
    expect(models.localModels).toMatchObject({ bridgeUp: true, leftOut: [], on: true, serversUp: ['default', SERVER] })
    // Hermes lists a provider by its key; a row it does not list yet is made up.
    expect(
      managedPickerRows(models, [
        { models: ['x'], slug: 'athena-gateway' },
        { models: [QWEN_NAME], slug: 'athena-vllm' },
        { models: [DEEPSEEK, 'another-of-its-54'], slug: 'athena-local-hpc-llm' }
      ]).map(row => [row.slug, row.models])
    ).toEqual([
      ['athena-gateway', ['gpt-6-luna']],
      ['athena-vllm', [QWEN_NAME]],
      ['athena-local-hpc-llm', [DEEPSEEK]]
    ])
    expect(managedPickerRows(models, []).map(row => [(row as { name?: string }).name, row.slug])).toEqual([
      ['Athena gateway', ATHENA_GATEWAY_PROVIDER],
      ['Local models', ATHENA_BRIDGE_PROVIDER],
      ['Local models (hpc-llm)', KEYED_PROVIDER]
    ])
  })

  test('a pick is accepted on its own server provider only', () => {
    const models = managedModels(config(), both)

    const pick = (model: string, provider?: string) =>
      modelUseDecision(models, { model, provider }, 'rpc', 'config.set').allowed

    expect(pick(DEEPSEEK, KEYED_PROVIDER)).toBe(true)
    expect(pick(DEEPSEEK, 'athena-local-hpc-llm')).toBe(true)
    expect(pick(DEEPSEEK)).toBe(true)
    expect(pick(QWEN_NAME, ATHENA_BRIDGE_PROVIDER)).toBe(true)
    // Not on the other server's provider (it would be sent there without, or with the wrong, key), nor the gateway.
    expect(pick(DEEPSEEK, ATHENA_BRIDGE_PROVIDER)).toBe(false)
    expect(pick(QWEN_NAME, KEYED_PROVIDER)).toBe(false)
    expect(pick(DEEPSEEK, ATHENA_GATEWAY_PROVIDER)).toBe(false)
    expect(pick('gpt-6-luna', KEYED_PROVIDER)).toBe(false)
    expect(pick('another-of-its-54', KEYED_PROVIDER)).toBe(false)
  })

  test.each([
    ['only the default server up', { bridgeUp: true, serversUp: ['default'] }, [QWEN_NAME]],
    ['a record without a server list (version 1)', { bridgeUp: true }, [QWEN_NAME]],
    ['only the keyed server up', { bridgeUp: true, serversUp: [SERVER] }, [DEEPSEEK]],
    ['a server the config does not name up', { bridgeUp: true, serversUp: ['another'] }, []],
    ['no bridge', { bridgeUp: false, serversUp: ['default', SERVER] }, []]
  ])('%s: only the models of a server that is up are listed and accepted', (_name, state, listed) => {
    const models = managedModels(config(), state)

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-luna', ...listed])
    // What the config offers stays known (labels of old sessions, the later status slices).
    expect(models.localModels.configured.map(entry => entry.id)).toEqual([QWEN_NAME, DEEPSEEK])

    for (const [model, provider] of [
      [QWEN_NAME, ATHENA_BRIDGE_PROVIDER],
      [DEEPSEEK, KEYED_PROVIDER]
    ]) {
      expect(modelUseDecision(models, { model, provider }, 'rpc', 'config.set').allowed).toBe(listed.includes(model))
    }
  })

  test('bridgeState: a snapshot bridge with a server list, without one, and none', () => {
    expect(bridgeState({ port: 1, servers: { default: 1, [SERVER]: 2 } })).toEqual({
      bridgeUp: true,
      serversUp: ['default', SERVER]
    })
    expect(bridgeState({ servers: { [SERVER]: 2 } })).toEqual({ bridgeUp: true, serversUp: [SERVER] })
    expect(bridgeState({ port: 1 })).toEqual({ bridgeUp: true, serversUp: ['default'] })
    expect(bridgeState(undefined)).toEqual({ bridgeUp: false, serversUp: [] })
  })

  test.each([
    [
      'a key source this build does not know',
      { [SERVER]: { ...KEYED, key: { type: 'per_user' } } },
      'key_type_unknown'
    ],
    ['a key that is not a source', { [SERVER]: { ...KEYED, key: 'text' } }, 'key_type_unknown'],
    ['a server the config does not list', {}, 'server_unknown'],
    ['a server without a port', { [SERVER]: { host: KEYED.host } }, 'server_unknown']
  ])('%s: that server models are left out with the reason, the others stay', (_name, servers, reason) => {
    const models = managedModels(withoutModelServerKeys(document({ servers })), both)

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-luna', QWEN_NAME])
    expect(models.localModels.configured.map(entry => entry.id)).toEqual([QWEN_NAME])
    expect(models.localModels.leftOut).toEqual([{ configId: DEEPSEEK, reason, server: SERVER }])
    expect(modelUseDecision(models, { model: DEEPSEEK, provider: KEYED_PROVIDER }, 'rpc', 'config.set').allowed).toBe(
      false
    )
  })

  test('a server that takes no key is used as it is', () => {
    const models = managedModels(document({ servers: { [SERVER]: KEYED } }), both)

    expect(models.visible.map(entry => entry.id)).toEqual(['gpt-6-luna', QWEN_NAME, DEEPSEEK])
  })
})
