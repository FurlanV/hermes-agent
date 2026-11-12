// F03 slice 02: main's one "current catalog" function and its channels. Today it always answers the bundled
// catalog; the channels are installed with the client config (main.ts needs no new hook) and preload reads them.
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { CATALOG_CHANNELS, currentCatalogSource, installAthenaCatalogSource } from './catalog-source'
import { installAthenaClientConfig } from './client-config-ipc'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('the current catalog in main', () => {
  test('is the bundled catalog', () => {
    expect(currentCatalogSource()).toEqual({ catalog: null, error: null, source: 'bundled' })
  })

  test('answers on the Athena channels the preload bridge reads', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (c: string, fn: (...args: any[]) => unknown) => handlers.set(c, fn), on: (c: string, fn: (...args: any[]) => unknown) => handlers.set(c, fn) }
    const lines: string[] = []
    installAthenaCatalogSource(ipcMain as never, line => lines.push(line))

    const event: { returnValue?: unknown } = {}
    handlers.get(CATALOG_CHANNELS.snapshot)!(event)
    expect(event.returnValue).toEqual({ catalog: null, error: null, source: 'bundled' })
    expect(await handlers.get(CATALOG_CHANNELS.get)!()).toEqual({ catalog: null, error: null, source: 'bundled' })
    expect(lines).toEqual(['[athena] tool catalog: bundled'])

    const bridge = readFileSync(path.join(import.meta.dirname, 'preload-bridge.ts'), 'utf8')
    expect(bridge).toContain(`'${CATALOG_CHANNELS.snapshot}'`)
    expect(bridge).toContain(`'${CATALOG_CHANNELS.get}'`)
  })

  test('is installed with the client config', () => {
    const athenaDir = mkdtempSync(path.join(tmpdir(), 'athena-catalog-'))
    dirs.push(athenaDir)
    const handlers = new Map<string, unknown>()
    const ipcMain = { handle: (c: string, fn: unknown) => handlers.set(c, fn), on: (c: string, fn: unknown) => handlers.set(c, fn) }
    const cc = installAthenaClientConfig({ allWindows: () => [], athenaDir, env: {}, installStamp: null, ipcMain: ipcMain as never, log: () => {} })

    try {
      expect(handlers.has(CATALOG_CHANNELS.snapshot) && handlers.has(CATALOG_CHANNELS.get)).toBe(true)
    } finally {
      cc.stop()
    }
  })
})
