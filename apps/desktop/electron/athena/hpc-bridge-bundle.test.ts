// F05 slice 06: the bridge inside a bundle built like Electron main's (scripts/bundle-electron-main.mjs: one ES
// module, esbuild, `require` from a banner). ssh2 is CommonJS and reads `__dirname` while it loads, which an ES
// module does not have: a careless import stops main at startup, and no unit test of the source would notice.
// This builds such a bundle, checks that loading it touches no SSH code, and runs the forward through it.
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const here = import.meta.dirname
const desktop = path.resolve(here, '../..')
const source = (name: string) => JSON.stringify(path.join(here, name))

// What main does with the bridge, on a stand-in login node and model server (loopback only).
const ENTRY = `
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// A top-level import, as main.ts has it: evaluating the bundle must not run ssh2.
import { HpcBridge, loadSsh2 } from ${source('hpc-bridge.ts')}

export async function run() {
  // The bridge's own loader first, then the stand-in (which also uses ssh2, by then loaded).
  const { Client } = await loadSsh2()
  const leaked = '__dirname' in globalThis || typeof Client !== 'function'
  const { chat, keyLine, newKeyPair, startLoginNode, startModelServer } = await import(${source('hpc-bridge.test-helper.ts')})
  const dir = mkdtempSync(path.join(tmpdir(), 'athena-bridge-bundle-'))
  const user = newKeyPair()
  const model = await startModelServer()
  const login = await startLoginNode({ authorizedKey: user.public, route: () => model.port })

  const config = {
    features: { F05: 'on' },
    local_models: { enabled: true, login_host: '127.0.0.1', login_port: login.port, target_host: 'node.test', target_port: 9931 }
  }

  const bridge = new HpcBridge({
    athenaDir: dir,
    hostKeys: { ['127.0.0.1:' + login.port]: [keyLine(login.hostKey.public)] },
    keyProvider: () => ({ privateKey: user.private, username: 'someone' }),
    snapshot: () => ({ config })
  })

  try {
    bridge.reconcile()
    const started = Date.now()

    while (bridge.status().state !== 'connected' && Date.now() - started < 10000) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const state = bridge.status().state
    const answer = state === 'connected' ? await chat(bridge.localPort, 'a-model') : null

    return { content: answer?.body.choices[0].message.content ?? null, leaked: leaked || '__dirname' in globalThis, state }
  } finally {
    bridge.stop()
    await login.close()
    await model.close()
    rmSync(dir, { force: true, recursive: true })
  }
}
`

const RUNNER = `
const bundle = await import(process.argv[2])
// Loading main's bundle must not have run ssh2 (it would have thrown here, with no __dirname in an ES module).
const result = await bundle.run()
console.log('RESULT ' + JSON.stringify(result))
process.exit(0)
`

let dir: string
let bundle: string

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'athena-bridge-bundle-test-'))
  bundle = path.join(dir, 'bundle.mjs')
  writeFileSync(path.join(dir, 'entry.ts'), ENTRY)
  writeFileSync(path.join(dir, 'runner.mjs'), RUNNER)

  // The options of bundleElectronMain's main build.
  await build({
    absWorkingDir: desktop,
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    bundle: true,
    entryPoints: [path.join(dir, 'entry.ts')],
    external: ['electron', 'node-pty', 'get-windows', 'fs'],
    format: 'esm',
    logLevel: 'silent',
    outfile: bundle,
    platform: 'node',
    target: 'node20'
  })
}, 60_000)

afterAll(() => rmSync(dir, { force: true, recursive: true }))

describe("the bridge in a bundle built like Electron main's", () => {
  test('the bundle carries ssh2 as plain JavaScript: no native addon is needed', () => {
    const text = readFileSync(bundle, 'utf8')

    expect(text).toContain('SSH-2.0-ssh2js')
    // The two optional native pieces are looked for inside a try and are not there: ssh2 falls back to node:crypto.
    expect(
      text.match(/__require\("cpu-features"\)|__require\("\.\/crypto\/build\/Release\/sshcrypto\.node"\)/g)
    ).toHaveLength(2)
  })

  test('it loads, connects and forwards a request, and leaves no __dirname behind', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join(dir, 'runner.mjs'), pathToFileURL(bundle).href],
        { timeout: 30_000 },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout))
      )
    })

    const line = output.split('\n').find(text => text.startsWith('RESULT '))

    expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({
      content: 'from the model node',
      leaked: false,
      state: 'connected'
    })
  }, 60_000)
})
