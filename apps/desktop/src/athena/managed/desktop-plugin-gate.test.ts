// F02 slice 29: the desktop-plugin loader evaluates a `$HERMES_HOME/desktop-plugins/<folder>/plugin.js` only when its
// sha256 is on the build's list (desktop-plugins.json) and it declares the listed id, while managed.tools is enforce.
// A dropped-in plugin.js is ignored with a log line (and the refusal recorded); the Athena plugin built from athena's
// client/desktop-plugins/athena still loads. Under report the dropped-in plugin loads and the load is recorded;
// under off it is stock. A switch change re-checks what is loaded. The real loader runs over a stubbed disk.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { $pluginRecords } from '@/contrib/plugins-store'
import { discoverRuntimePlugins, unloadRuntimePlugin, watchRuntimePlugins } from '@/contrib/runtime-loader'
import type { HermesReadDirResult } from '@/global'

import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'

import { $clientConfig, type ClientConfigSnapshot, setClientConfigSnapshot } from './client-config'
import { $desktopPluginMode, desktopPluginVerdict, sha256Hex } from './desktop-plugin-gate'
import allowlist from './desktop-plugins.json'
import { installFeaturePolicy } from './feature-policy'
import { installToolInstallPolicy } from './tool-installs'

const athenaRepo = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const athenaDist = path.join(athenaRepo, 'client/desktop-plugins/athena/dist/athena/plugin.js')
const hashScript = path.resolve(import.meta.dirname, '../scripts/desktop-plugin-hash.mjs')

const bundled = BUNDLED_DEFAULT_CONFIG as Record<string, unknown>

const snapshot = (tools: string): ClientConfigSnapshot => ({
  config: { ...bundled, managed: { ...(bundled.managed as object), tools } },
  configVersion: null,
  devOverridesActive: false,
  error: 'missing',
  role: null,
  source: 'bundled',
  verifiedAt: null
})

const ROOT = '/home/.hermes/desktop-plugins'
// Late-bound: node caches a data: module by URL, so the same source evaluates once per file.
const DROPPED = 'export default { id: "dropped", register: (...args) => globalThis.__droppedRegister(...args) }'

const sources = new Map<string, string>()

const readDir = vi.fn(async (dir: string): Promise<HermesReadDirResult> => {
  if (dir === ROOT) {
    return {
      entries: [...new Set([...sources.keys()].map(file => file.split('/').at(-2)!))].map(name => ({
        isDirectory: true,
        name,
        path: `${ROOT}/${name}`
      }))
    }
  }

  const file = `${dir}/plugin.js`

  return { entries: sources.has(file) ? [{ isDirectory: false, name: 'plugin.js', path: file }] : [] }
})

const record = vi.fn()
const warn = vi.spyOn(console, 'warn')
let uninstall: Array<() => void> = []

// The loader evaluates plugins through blob-URL import(), which vite's module runner can't resolve in tests: reroute
// to data: URLs, which node's ESM loader handles (as src/contrib/runtime-loader.test.ts does).
const RealBlob = globalThis.Blob

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    blob => `data:text/javascript;base64,${Buffer.from((blob as unknown as { parts: string[] }).parts.join('')).toString('base64')}`
  )
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.stubGlobal(
    'Blob',
    class {
      parts: string[]
      constructor(parts: string[]) {
        this.parts = parts
      }
    }
  )
  record.mockReset()
  warn.mockClear()
  sources.clear()
  ;(globalThis as { __droppedRegister?: unknown }).__droppedRegister = vi.fn()
  ;(window as unknown as { athenaDesktop: unknown }).athenaDesktop = { policy: { record } }
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    desktopPluginsRoot: async () => ROOT,
    onPreviewFileChanged: vi.fn(),
    readDir,
    readFileText: vi.fn(),
    readPluginSource: async (file: string) => ({ text: sources.get(file) ?? '', truncated: false }),
    stopPreviewFileWatch: vi.fn(async () => true),
    watchPreviewFile: vi.fn(async (file: string) => ({ id: file }))
  }
  uninstall = [installFeaturePolicy(), installToolInstallPolicy()]
})

afterEach(async () => {
  uninstall.forEach(off => off())
  $clientConfig.set(null)
  sources.clear()
  await discoverRuntimePlugins()
  unloadRuntimePlugin('dropped')
  delete (window as unknown as { athenaDesktop?: unknown }).athenaDesktop
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  vi.stubGlobal('Blob', RealBlob)
  vi.mocked(URL.createObjectURL).mockRestore()
  vi.mocked(URL.revokeObjectURL).mockRestore()
})

const dropped = () => (globalThis as unknown as { __droppedRegister: ReturnType<typeof vi.fn> }).__droppedRegister

describe('a plugin.js dropped into desktop-plugins', () => {
  test('enforce: it is not evaluated, a line is logged, and the refusal recorded', async () => {
    setClientConfigSnapshot(snapshot('enforce'))
    sources.set(`${ROOT}/dropped/plugin.js`, DROPPED)

    await discoverRuntimePlugins()

    expect(dropped()).not.toHaveBeenCalled()
    expect($pluginRecords.get().dropped).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[athena\] desktop plugin dropped\/plugin\.js ignored/))
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refused', id: 'install:desktop-plugin', kind: 'tool', surface: 'desktop-plugin' })
    )
  })

  test('report: it loads, and the load is recorded', async () => {
    setClientConfigSnapshot(snapshot('report'))
    sources.set(`${ROOT}/dropped/plugin.js`, DROPPED)

    await discoverRuntimePlugins()

    expect(dropped()).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'allowed_in_report', id: 'install:desktop-plugin', kind: 'tool' })
    )
  })

  test('off: stock, nothing recorded; and no policy installed (a test host) loads it too', async () => {
    setClientConfigSnapshot(snapshot('off'))
    sources.set(`${ROOT}/dropped/plugin.js`, DROPPED)

    await discoverRuntimePlugins()
    expect(dropped()).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()

    uninstall.forEach(off => off())
    uninstall = []
    expect($desktopPluginMode.get()).toBeNull()
    await expect(desktopPluginVerdict(DROPPED, 'dropped')).resolves.toEqual({ allowed: true })
  })

  test('a switch to enforce unloads it; back to off loads it again', async () => {
    setClientConfigSnapshot(snapshot('off'))
    sources.set(`${ROOT}/dropped/plugin.js`, DROPPED)
    watchRuntimePlugins()
    await vi.waitFor(() => expect($pluginRecords.get().dropped?.status).toBe('loaded'))

    setClientConfigSnapshot(snapshot('enforce'))
    await vi.waitFor(() => expect($pluginRecords.get().dropped).toBeUndefined())

    setClientConfigSnapshot(snapshot('off'))
    await vi.waitFor(() => expect($pluginRecords.get().dropped?.status).toBe('loaded'))
  })
})

describe('the Athena plugin', () => {
  test('the allowlist names the athena plugin by id and hash', () => {
    expect(allowlist.plugins.map(plugin => plugin.id)).toEqual(['athena'])
    expect(allowlist.plugins[0].sha256.every(hash => /^[0-9a-f]{64}$/.test(hash))).toBe(true)
  })

  test('a folder named athena with another source is not the Athena plugin', async () => {
    setClientConfigSnapshot(snapshot('enforce'))
    const impostor = 'export default { id: "athena", register() {} }'

    expect(await sha256Hex(impostor)).toMatch(/^[0-9a-f]{64}$/)
    await expect(desktopPluginVerdict(impostor, 'athena')).resolves.toEqual({ allowed: false })
  })

  test.skipIf(!existsSync(athenaDist))('the built athena plugin still loads under enforce, beside an ignored one', async () => {
    setClientConfigSnapshot(snapshot('enforce'))
    sources.set(`${ROOT}/athena/plugin.js`, readFileSync(athenaDist, 'utf8'))
    sources.set(`${ROOT}/dropped/plugin.js`, DROPPED)

    await expect(desktopPluginVerdict(readFileSync(athenaDist, 'utf8'), 'athena')).resolves.toEqual({
      allowed: true,
      id: 'athena'
    })
    await discoverRuntimePlugins()

    expect($pluginRecords.get().athena).toMatchObject({ id: 'athena', kind: 'disk', status: 'loaded' })
    expect(dropped()).not.toHaveBeenCalled()
    unloadRuntimePlugin('athena')
  })

  test.skipIf(!existsSync(path.join(athenaRepo, 'client/desktop-plugins/athena/node_modules/esbuild')))(
    'the list matches a fresh build of athena client/desktop-plugins/athena',
    () => {
      expect(() =>
        execFileSync(process.execPath, [hashScript, '--check'], {
          env: { ...process.env, ATHENA_REPO: athenaRepo },
          stdio: 'pipe'
        })
      ).not.toThrow()
    }
  )
})
