// F05 slice 07: the HPC bridge signs in with the user's HPC user name and password. Electron main keeps the
// password in memory for the app's run: it reconnects without asking, forgets it on quit, on Disconnect and when the
// login host refuses it, and never writes it anywhere. The pinned host key is checked before the password is sent.
// A configured key (slice 06) still wins. Everything runs against a stand-in login node and model server on
// loopback (hpc-bridge.test-helper.ts); no real host is contacted.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { isPolicyIpcChannel } from './backend-policy'
import { BUNDLED_DEFAULT_CONFIG } from './bundled-config-data'
import { AthenaClientConfig } from './client-config'
import {
  HPC_BRIDGE_CHANNELS,
  HpcBridge,
  type HpcBridgeOptions,
  type HpcBridgeStatus,
  installAthenaHpcBridge
} from './hpc-bridge'
import { bridgeRecordFile, readBridgeRecord } from './hpc-bridge-record'
import {
  BRIDGE_USER_FILE,
  bridgePassword,
  BridgePassword,
  bridgeUsername,
  readBridgeUser,
  writeBridgeUser
} from './hpc-bridge-user'
import {
  chat,
  keyLine,
  type KeyPair,
  type LoginAccount,
  type LoginNode,
  type ModelServer,
  newKeyPair,
  startLoginNode,
  startModelServer
} from './hpc-bridge.test-helper'
import { applyMainPolicies } from './main-policy'
import { installIpcPolicyGuard, setMainPolicySeams } from './policy-seams'

const LOGIN_HOST = '127.0.0.1'
const TARGET_HOST = 'model-node.test'
const TARGET_PORT = 9931
const USER = 'researcher1'
const PASSWORD = 'correct horse battery staple'
const QWEN_ID = 'qwen-3.8-27B-GGUF'
const QWEN_NAME = 'DevQuasar/Qwen.Qwen3.8-27B-GGUF'

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
let account: LoginAccount
let userKey: KeyPair
let bridges: HpcBridge[]

const document = (options: { feature?: 'off' | 'on'; switchOn?: boolean } = {}): Record<string, unknown> => ({
  ...bundled,
  features: { ...(bundled.features as object), F05: options.feature ?? 'on' },
  local_models: {
    enabled: options.switchOn ?? true,
    login_host: LOGIN_HOST,
    login_port: login.port,
    models: { [QWEN_ID]: { name: QWEN_NAME } },
    target_host: TARGET_HOST,
    target_port: TARGET_PORT
  },
  managed: { ...(bundled.managed as object), features: 'enforce' },
  models: {
    allowed: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { id: QWEN_ID, label: 'Qwen 3.8 27B (local)', provider: 'bridge' }
    ],
    default: 'gpt-6-luna'
  }
})

const pins = () => ({ [`${LOGIN_HOST}:${login.port}`]: [keyLine(login.hostKey.public)] })

interface Harness {
  bridge: HpcBridge
  config: { current: Record<string, unknown> }
  log: string[]
  statuses: HpcBridgeStatus[]
}

/** A bridge with no configured key, as on a user's laptop: only the password signs in. */
function harness(options: Partial<HpcBridgeOptions> = {}): Harness {
  const config = { current: document() }
  const log: string[] = []
  const statuses: HpcBridgeStatus[] = []

  const bridge = new HpcBridge({
    applyConfig: async () => true,
    athenaDir,
    hostKeys: pins(),
    keyProvider: () => null,
    log: line => log.push(line),
    onStatus: status => statuses.push(status),
    snapshot: () => ({ config: config.current }),
    timings: FAST,
    ...options
  })

  bridges.push(bridge)

  return { bridge, config, log, statuses }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const connected = (h: Harness) => vi.waitFor(() => expect(h.bridge.status().state).toBe('connected'), { timeout: 5000 })
const methods = () => login.auth.map(entry => entry.method)

/** Every file under a folder, with its bytes. */
function filesUnder(root: string): { bytes: Buffer; file: string }[] {
  const found: { bytes: Buffer; file: string }[] = []

  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const file = path.join(root, name)

    if (statSync(file).isDirectory()) {
      found.push(...filesUnder(file))
    } else {
      found.push({ bytes: readFileSync(file), file })
    }
  }

  return found
}

/** The forms a secret could take in a file or a log line: as typed, and the usual encodings of it. */
const formsOf = (secret: string): string[] => [
  secret,
  Buffer.from(secret).toString('base64'),
  Buffer.from(secret).toString('hex'),
  encodeURIComponent(secret),
  JSON.stringify(secret).slice(1, -1)
]

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-hpc-password-'))
  athenaDir = path.join(home, 'hermes', 'athena')
  mkdirSync(athenaDir, { recursive: true })
  userKey = newKeyPair()
  account = { password: PASSWORD, username: USER }
  model = await startModelServer()
  login = await startLoginNode({
    account,
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

describe('signing in with the password', () => {
  test('before a sign-in nothing connects: no_key, with nothing held', async () => {
    const h = harness()
    h.bridge.reconcile()
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('no_key'))
    await pause(50)

    expect(h.bridge.status()).toMatchObject({ credential: 'none', state: 'no_key' })
    expect(h.bridge.status().username).toBeUndefined()
    expect(login.connections).toBe(0)
    // Asking to connect with nothing held changes nothing: the dialog has to ask.
    expect(await h.bridge.connect()).toMatchObject({ credential: 'none', state: 'no_key' })
    expect(login.connections).toBe(0)
  })

  test('a user name and password open the bridge, and a chat through it answers from the model server', async () => {
    const h = harness()
    h.bridge.reconcile()

    const status = await h.bridge.signIn({ password: PASSWORD, username: USER })

    // The answer comes once the attempt has settled, so the dialog can say how it went.
    expect(status).toMatchObject({ credential: 'password', state: 'connected', username: USER })
    expect(status.servers).toEqual({ default: { port: status.port, state: 'up' } })
    // As OpenSSH does: ask which methods the node takes, then the password, once. No key was offered.
    expect(methods()).toEqual(['none', 'password'])
    expect(login.auth.every(entry => entry.username === USER)).toBe(true)
    expect(login.passwords).toEqual([PASSWORD])

    const answer = await chat(status.port!, QWEN_NAME)

    expect(answer.status).toBe(200)
    expect(answer.body.choices[0].message.content).toBe('from the model node')
    expect(login.forwards).toContainEqual({ host: TARGET_HOST, port: TARGET_PORT })
    expect(readBridgeRecord(athenaDir)).toMatchObject({ address: '127.0.0.1', port: status.port })
    // The user name, and only the user name, is remembered for the next launch.
    expect(JSON.parse(readFileSync(path.join(athenaDir, BRIDGE_USER_FILE), 'utf8'))).toEqual({ username: USER })
  })

  test('a login node that asks for the password with a keyboard prompt is answered the same way', async () => {
    account.ask = 'keyboard-interactive'
    const h = harness()
    h.bridge.reconcile()

    expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({ state: 'connected' })
    expect(methods()).toEqual(['none', 'keyboard-interactive'])
    expect(login.passwords).toEqual([PASSWORD])
    expect((await chat(h.bridge.status().port!, QWEN_NAME)).status).toBe(200)
  })

  test('after the connection drops the bridge is back by itself, with no new sign-in', async () => {
    const h = harness()
    h.bridge.reconcile()
    await h.bridge.signIn({ password: PASSWORD, username: USER })

    login.drop()
    await vi.waitFor(() => expect(login.connections).toBe(2))
    await connected(h)

    // Main signed in again from memory: nobody was asked, and the status never fell back to "nothing held".
    expect(login.passwords).toEqual([PASSWORD, PASSWORD])
    expect(h.statuses.some(status => status.state === 'no_key' || status.credential === 'none')).toBe(false)
    expect((await chat(h.bridge.status().port!, QWEN_NAME)).status).toBe(200)

    // A wake from sleep (the connection is taken for dead) and a link that died silently: the same.
    h.bridge.kick({ force: true })
    await vi.waitFor(() => expect(login.connections).toBe(3))
    await connected(h)
    login.stall()
    await vi.waitFor(() => expect(login.connections).toBe(4), { timeout: 5000 })
    await connected(h)
    expect(h.bridge.status()).toMatchObject({ credential: 'password', username: USER })
  })

  test('while the login node cannot be reached the password is kept, and the bridge is back when the node is', async () => {
    const h = harness()
    h.bridge.reconcile()
    await h.bridge.signIn({ password: PASSWORD, username: USER })

    await login.goAway()
    await vi.waitFor(() => expect(h.bridge.status()).toMatchObject({ reason: 'unreachable', state: 'down' }))
    expect(h.bridge.status().credential).toBe('password')

    await login.listen()
    await connected(h)
  })

  test('after quit and relaunch the user name is remembered and the password is asked for again', async () => {
    const first = harness()
    first.bridge.reconcile()
    await first.bridge.signIn({ password: PASSWORD, username: USER })
    first.bridge.stop()

    expect(first.bridge.status()).toMatchObject({ credential: 'none', state: 'off' })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    const before = login.connections

    // The next launch: a new main process has only what is on disk.
    const next = harness()
    next.bridge.reconcile()
    await vi.waitFor(() => expect(next.bridge.status().state).toBe('no_key'))

    expect(next.bridge.status()).toMatchObject({ credential: 'none', state: 'no_key', username: USER })
    expect(await next.bridge.connect()).toMatchObject({ state: 'no_key' })
    await pause(100)
    expect(login.connections).toBe(before)

    expect(await next.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({ state: 'connected' })
  })

  test('what is not a user name or a password is refused before anything is kept or sent', async () => {
    const h = harness()
    h.bridge.reconcile()

    for (const input of [
      undefined,
      {},
      { username: USER },
      { password: PASSWORD },
      { password: '', username: USER },
      { password: PASSWORD, username: '' },
      { password: PASSWORD, username: '-oProxyCommand=x' },
      { password: PASSWORD, username: 'two words' },
      { password: PASSWORD, username: 'a\nb' },
      { password: 'x'.repeat(2000), username: USER },
      { password: 7, username: USER }
    ]) {
      await expect(h.bridge.signIn(input)).rejects.toThrow('a user name and a password are needed')
    }

    expect(h.bridge.status()).toMatchObject({ credential: 'none' })
    expect(login.connections).toBe(0)
    expect(bridgeUsername(' researcher.1_a-b ')).toBe('researcher.1_a-b')
    // A password is taken as typed: its spaces are part of it.
    expect(bridgePassword(' two  spaces ')).toBe(' two  spaces ')
  })

  test('while local models are off a sign-in keeps nothing and contacts nothing', async () => {
    for (const config of [document({ feature: 'off' }), document({ switchOn: false })]) {
      const h = harness()
      h.config.current = config
      h.bridge.reconcile()

      expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({
        credential: 'none',
        state: 'off'
      })

      // Turned on later: nothing was kept from before.
      h.config.current = document()
      h.bridge.reconcile()
      await vi.waitFor(() => expect(h.bridge.status().state).toBe('no_key'))
      expect(h.bridge.status().credential).toBe('none')
      h.bridge.stop()
    }

    expect(login.connections).toBe(0)
    expect(readBridgeUser(athenaDir)).toBeNull()
  })

  test('local models going off forgets the password', async () => {
    const h = harness()
    h.bridge.reconcile()
    await h.bridge.signIn({ password: PASSWORD, username: USER })

    h.config.current = document({ switchOn: false })
    h.bridge.reconcile()
    expect(h.bridge.status()).toMatchObject({ credential: 'none', reason: 'switch_off', state: 'off' })

    h.config.current = document()
    h.bridge.reconcile()
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('no_key'))
    expect(login.passwords).toEqual([PASSWORD])
  })
})

describe('a password the login node does not take', () => {
  test('a wrong password: a clear reason, nothing opened and nothing kept', async () => {
    const h = harness()
    h.bridge.reconcile()

    const status = await h.bridge.signIn({ password: 'not the password', username: USER })

    expect(status).toMatchObject({ credential: 'none', reason: 'auth_failed', state: 'down' })
    expect(status.username).toBeUndefined()
    // Sent once: a wrong password costs the account one failed attempt, not one per method or per retry.
    expect(login.passwords).toEqual(['not the password'])
    expect(methods()).toEqual(['none', 'password'])
    // Nothing opened: no forward, no loopback port, no record. Nothing kept: no user name on disk either.
    expect(login.forwards).toEqual([])
    expect(h.bridge.localPort).toBeNull()
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(existsSync(path.join(athenaDir, BRIDGE_USER_FILE))).toBe(false)

    // Not tried again by itself, on a wake, or on a request to connect: the password is gone.
    await pause(300)
    h.bridge.kick({ force: true })
    await pause(100)
    expect(login.connections).toBe(1)
    expect(await h.bridge.connect()).toMatchObject({ credential: 'none', state: 'no_key' })
    await pause(100)
    expect(login.connections).toBe(1)

    // The right one then works.
    expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({ state: 'connected' })
  })

  test('a wrong password to a keyboard prompt is sent once too', async () => {
    account.ask = 'keyboard-interactive'
    const h = harness()
    h.bridge.reconcile()

    expect(await h.bridge.signIn({ password: 'nope', username: USER })).toMatchObject({
      credential: 'none',
      reason: 'auth_failed',
      state: 'down'
    })
    await pause(200)
    expect(login.passwords).toEqual(['nope'])
    expect(login.connections).toBe(1)
  })

  test('a wrong password after a good sign-in keeps the user name of the good one', async () => {
    const h = harness()
    h.bridge.reconcile()
    await h.bridge.signIn({ password: PASSWORD, username: USER })
    h.bridge.disconnect()

    expect(await h.bridge.signIn({ password: 'wrong', username: 'someoneelse' })).toMatchObject({
      reason: 'auth_failed',
      username: USER
    })
    expect(readBridgeUser(athenaDir)).toBe(USER)
  })

  test('the password changed on the HPC: the reconnect is refused once and the bridge waits for a new sign-in', async () => {
    const h = harness()
    h.bridge.reconcile()
    await h.bridge.signIn({ password: PASSWORD, username: USER })

    account.password = 'a new password'
    login.drop()
    await vi.waitFor(() => expect(h.bridge.status()).toMatchObject({ reason: 'auth_failed', state: 'down' }))

    expect(h.bridge.status()).toMatchObject({ credential: 'none', username: USER })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    await pause(300)
    // One refused attempt with the old password, and no more.
    expect(login.passwords).toEqual([PASSWORD, PASSWORD])
    expect(login.connections).toBe(2)

    expect(await h.bridge.signIn({ password: 'a new password', username: USER })).toMatchObject({ state: 'connected' })
  })

  test('a login node that asks for more than a password is not answered: auth_unsupported', async () => {
    const cases: { account: Partial<LoginAccount>; sent: string[] }[] = [
      // A code asked together with the password: nothing is answered, the password is not sent.
      { account: { ask: 'keyboard-interactive', secondFactor: 'together' }, sent: [] },
      // A code asked after the password: the password went once, the second question gets nothing.
      { account: { ask: 'keyboard-interactive', secondFactor: 'after' }, sent: [PASSWORD] },
      // The password accepted, then another method wanted (a partial success).
      { account: { thenMore: true }, sent: [PASSWORD] }
    ]

    for (const entry of cases) {
      Object.assign(account, { ask: undefined, secondFactor: undefined, thenMore: undefined }, entry.account)
      login.passwords.length = 0
      const before = login.connections
      const h = harness()
      h.bridge.reconcile()

      expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({
        credential: 'none',
        reason: 'auth_unsupported',
        state: 'down'
      })
      await pause(200)
      expect(login.passwords).toEqual(entry.sent)
      expect(login.connections).toBe(before + 1)
      expect(readBridgeRecord(athenaDir)).toBeNull()
      h.bridge.stop()
    }
  })

  test('a login node that takes no password at all: auth_unsupported, nothing sent', async () => {
    await login.close()
    login = await startLoginNode({ authorizedKey: userKey.public, route: () => model.port })
    const h = harness()
    h.bridge.reconcile()

    expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({
      credential: 'none',
      reason: 'auth_unsupported',
      state: 'down'
    })
    expect(methods()).toEqual(['none'])
    expect(login.passwords).toEqual([])
  })
})

describe('the pinned host key and the password', () => {
  test('another host key stops the sign-in before the user name or the password is sent', async () => {
    const other = newKeyPair()

    for (const pin of [keyLine(other.public), `SHA256:${'A'.repeat(43)}`]) {
      login.connections = 0
      const h = harness({ hostKeys: { [`${LOGIN_HOST}:${login.port}`]: [pin] } })
      h.bridge.reconcile()

      expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({
        reason: 'host_key_mismatch',
        state: 'down'
      })
      await pause(100)

      // The node was reached, and saw no authentication request of any kind: no user name, no password.
      expect(login.connections).toBe(1)
      expect(login.auth).toEqual([])
      expect(login.passwords).toEqual([])
      expect(readBridgeRecord(athenaDir)).toBeNull()
      expect(existsSync(path.join(athenaDir, BRIDGE_USER_FILE))).toBe(false)
      expect(h.log.join('\n')).toMatch(/which is not pinned in this build; refused/)
      h.bridge.stop()
    }
  })

  test('a host the build does not pin is never contacted, whatever is entered', async () => {
    const h = harness({ hostKeys: {} })
    h.bridge.reconcile()

    expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({ state: 'host_key_unknown' })
    await pause(50)
    expect(login.connections).toBe(0)
  })
})

describe('a configured key and the password', () => {
  test('a configured key is used as before, and a password entered beside it is dropped unused', async () => {
    const h = harness({ keyProvider: () => ({ privateKey: userKey.private, username: 'keyuser' }) })
    h.bridge.reconcile()
    await connected(h)

    expect(h.bridge.status()).toMatchObject({ credential: 'key', state: 'connected' })
    expect(methods().every(method => method === 'publickey')).toBe(true)

    expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({
      credential: 'key',
      state: 'connected'
    })
    expect(methods().every(method => method === 'publickey')).toBe(true)
    expect(login.auth.every(entry => entry.username === 'keyuser')).toBe(true)
    expect(login.passwords).toEqual([])

    // Disconnect and connect again: still the key, with no dialog.
    h.bridge.disconnect()
    expect(await h.bridge.connect()).toMatchObject({ state: 'connecting' })
    await connected(h)
    expect(login.passwords).toEqual([])
  })
})

describe('disconnecting and forgetting', () => {
  test('Disconnect closes the forward and forgets the password: the next connect needs a sign-in', async () => {
    const h = harness()
    h.bridge.reconcile()
    const { port } = await h.bridge.signIn({ password: PASSWORD, username: USER })

    expect(h.bridge.disconnect()).toMatchObject({
      credential: 'none',
      reason: 'disconnected',
      state: 'off',
      username: USER
    })
    expect(readBridgeRecord(athenaDir)).toBeNull()
    expect(h.bridge.localPort).toBeNull()
    await expect(chat(port!, QWEN_NAME)).rejects.toThrow()

    const before = login.connections
    expect(await h.bridge.connect()).toMatchObject({ credential: 'none', state: 'no_key' })
    await pause(100)
    expect(login.connections).toBe(before)
    expect(login.passwords).toEqual([PASSWORD])

    expect(await h.bridge.signIn({ password: PASSWORD, username: USER })).toMatchObject({ state: 'connected' })
  })

  test('forgetting the user name removes it from disk, and the sign-in with it', async () => {
    const h = harness()
    h.bridge.reconcile()
    await h.bridge.signIn({ password: PASSWORD, username: USER })
    expect(readBridgeUser(athenaDir)).toBe(USER)

    const status = h.bridge.forgetUser()

    expect(status.username).toBeUndefined()
    expect(status.credential).toBe('none')
    expect(existsSync(path.join(athenaDir, BRIDGE_USER_FILE))).toBe(false)
    await vi.waitFor(() => expect(h.bridge.status().state).toBe('no_key'))
    expect(readBridgeRecord(athenaDir)).toBeNull()

    // And while disconnected: the name goes, the state stays.
    await h.bridge.signIn({ password: PASSWORD, username: USER })
    h.bridge.disconnect()
    expect(h.bridge.forgetUser()).toMatchObject({ credential: 'none', reason: 'disconnected', state: 'off' })
    expect(h.bridge.status().username).toBeUndefined()
    expect(readBridgeUser(athenaDir)).toBeNull()
  })

  test('the remembered user name: read back only when it is one, written 0600', () => {
    expect(readBridgeUser(athenaDir)).toBeNull()
    writeBridgeUser(athenaDir, USER)
    expect(readBridgeUser(athenaDir)).toBe(USER)

    if (process.platform !== 'win32') {
      expect(statSync(path.join(athenaDir, BRIDGE_USER_FILE)).mode & 0o777).toBe(0o600)
    }

    for (const body of ['', '[]', '{"username": 7}', '{"username": "two words"}', 'not json']) {
      writeFileSync(path.join(athenaDir, BRIDGE_USER_FILE), body)
      expect(readBridgeUser(athenaDir)).toBeNull()
    }
  })

  test('the password holder gives nothing away when printed, inspected or serialised', () => {
    const holder = new BridgePassword()
    holder.set(PASSWORD)

    expect(holder.held).toBe(true)

    for (const printed of [
      String(holder),
      `${holder}`,
      JSON.stringify({ holder }),
      inspect(holder),
      inspect({ holder }, { depth: 9, showHidden: true })
    ]) {
      expect(printed).not.toContain(PASSWORD)
    }

    expect(Object.keys(holder)).toEqual([])
    holder.forget()
    expect(holder.held).toBe(false)
    expect(holder.use()).toBeNull()
  })
})

describe('the password stays in memory', () => {
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
    installIpcPolicyGuard(ipc as never, isPolicyIpcChannel)

    return ipc
  }

  function install(config: Record<string, unknown>) {
    const sent: unknown[] = []
    const log: string[] = []
    const listeners = new Map<string, () => void>()
    const ipc = fakeIpc()

    const source = new AthenaClientConfig({
      athenaDir,
      bundledDefault: config,
      onChange: snapshot => applyMainPolicies(snapshot)
    })

    applyMainPolicies(source.snapshot())

    const bridge = installAthenaHpcBridge({
      allWindows: () => [
        {
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
        } as never
      ],
      app: { on: (event, listener) => listeners.set(event, listener), whenReady: () => Promise.resolve() },
      applyConfig: async () => true,
      athenaDir,
      clientConfig: () => source,
      // No development key: `ATHENA_HPC_BRIDGE_*` is not set and dev overrides are off, as in a released build.
      env: {},
      hostKeys: pins(),
      installStamp: { brand: 'athena' },
      ipcMain: ipc as never,
      log: line => log.push(line),
      timings: FAST
    })

    bridges.push(bridge)

    const invoke = (channel: string, payload?: unknown) => {
      const handler = ipc.handlers.get(channel)

      if (!handler) {
        throw new Error(`No handler registered for '${channel}'`)
      }

      return payload === undefined ? handler({}) : handler({}, payload)
    }

    return { bridge, invoke, ipc, listeners, log, sent, source }
  }

  test('over IPC: the dialog signs in, Disconnect and Forget work, and the channels are the row`s', async () => {
    const app = install(document())
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('no_key'))

    expect([...app.ipc.handlers.keys()].sort()).toEqual(
      Object.values(HPC_BRIDGE_CHANNELS)
        .filter(channel => channel !== HPC_BRIDGE_CHANNELS.changed)
        .sort()
    )
    expect(isPolicyIpcChannel(HPC_BRIDGE_CHANNELS.forgetUser)).toBe(true)
    expect(await app.invoke(HPC_BRIDGE_CHANNELS.connect)).toMatchObject({ credential: 'none', state: 'no_key' })

    const status = (await app.invoke(HPC_BRIDGE_CHANNELS.connect, {
      password: PASSWORD,
      username: USER
    })) as HpcBridgeStatus

    expect(status).toMatchObject({ credential: 'password', state: 'connected', username: USER })
    expect(app.source.snapshot().hpcBridge).toMatchObject({ port: status.port })
    expect(app.invoke(HPC_BRIDGE_CHANNELS.disconnect)).toMatchObject({ credential: 'none', state: 'off' })
    expect(await app.invoke(HPC_BRIDGE_CHANNELS.connect)).toMatchObject({ state: 'no_key', username: USER })
    expect(app.invoke(HPC_BRIDGE_CHANNELS.forgetUser)).not.toHaveProperty('username')
    await expect(app.invoke(HPC_BRIDGE_CHANNELS.connect, { username: USER })).rejects.toThrow('are needed')
  })

  test('with the row off the sign-in is refused before it is looked at', async () => {
    const app = install(document({ feature: 'off' }))
    await pause(50)

    expect([...app.ipc.handlers.keys()]).toEqual([])
    expect(() => app.invoke(HPC_BRIDGE_CHANNELS.connect, { password: PASSWORD, username: USER })).toThrow(
      /No handler registered/
    )
    expect(login.connections).toBe(0)
    expect(readBridgeUser(athenaDir)).toBeNull()
  })

  test('a marker password is in no file of the Profile or the app data, no log line, no message to a window and no call', async () => {
    const MARKER = 'M4rk3r-p@ss "w0rd" \\ é 7f3a9c'
    const WRONG = 'Wr0ng-m4rker <pw> 51d0e2'
    const userData = path.join(home, 'userData')
    mkdirSync(userData, { recursive: true })
    account.password = MARKER
    const app = install(document())
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('no_key'))

    const answers: unknown[] = []

    // A refused sign-in first, then the right one; a chat; a drop and a reconnect from memory; a wake.
    answers.push(await app.invoke(HPC_BRIDGE_CHANNELS.connect, { password: WRONG, username: USER }))
    expect(answers[0]).toMatchObject({ reason: 'auth_failed', state: 'down' })
    answers.push(await app.invoke(HPC_BRIDGE_CHANNELS.connect, { password: MARKER, username: USER }))
    expect(answers[1]).toMatchObject({ state: 'connected' })
    expect((await chat(app.bridge.status().port!, QWEN_NAME)).status).toBe(200)
    login.drop()
    await vi.waitFor(() => expect(login.passwords.filter(sent => sent === MARKER)).toHaveLength(2))
    await vi.waitFor(() => expect(app.bridge.status().state).toBe('connected'), { timeout: 5000 })
    answers.push(await app.invoke(HPC_BRIDGE_CHANNELS.status))

    const secrets = [...formsOf(MARKER), ...formsOf(WRONG)]

    const clean = (what: string, text: string) => {
      for (const secret of secrets) {
        expect(text.includes(secret), `${what} holds the password`).toBe(false)
      }
    }

    const sweep = (when: string) => {
      // Every file under the Profile (the bridge record, the remembered ports and user name, the client config
      // cache, the policy-decision queue that capture ships) and under the app's own data folder.
      const files = [...filesUnder(path.join(home, 'hermes')), ...filesUnder(userData)]

      expect(files.map(entry => path.basename(entry.file))).toContain(BRIDGE_USER_FILE)

      for (const { bytes, file } of files) {
        clean(`${when}: ${file}`, bytes.toString('utf8'))
        clean(`${when}: ${file} (latin1)`, bytes.toString('latin1'))
      }

      clean(`${when}: the log`, app.log.join('\n'))
      clean(`${when}: a message to a window`, JSON.stringify(app.sent))
      clean(`${when}: an IPC answer`, JSON.stringify(answers))
      clean(`${when}: the client-config snapshot`, JSON.stringify(app.source.snapshot()))
      clean(`${when}: the bridge status`, JSON.stringify(app.bridge.status()))
      // What a diagnostic dump of the bridge object would print.
      clean(`${when}: the bridge, inspected`, inspect(app.bridge, { depth: 4 }))
      // What reached the model server (the only thing a captured turn could quote): no credential of the user's.
      clean(`${when}: a request to the model server`, JSON.stringify([model.requests, model.authorizations]))
    }

    expect(existsSync(bridgeRecordFile(athenaDir))).toBe(true)
    sweep('connected')

    answers.push(app.invoke(HPC_BRIDGE_CHANNELS.disconnect))
    sweep('disconnected')

    answers.push(await app.invoke(HPC_BRIDGE_CHANNELS.connect, { password: MARKER, username: USER }))
    app.listeners.get('will-quit')!()
    sweep('after quit')

    // The marker did reach the one place it is for: the login node, after its host key was checked.
    expect(login.passwords).toEqual([WRONG, MARKER, MARKER, MARKER])
  })
})
