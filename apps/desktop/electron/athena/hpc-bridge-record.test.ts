// F05 slice 05: how Electron main learns that this laptop's HPC bridge is up. It reads the Profile's bridge record
// (`$HERMES_HOME/athena/hpc-bridge.json`, athena's slice 04 format) into every client-config snapshot, polls it with
// the other inputs, and pushes a new snapshot when the bridge comes or goes. A stale record reads as none.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { AthenaClientConfig, type ClientConfigSnapshot } from './client-config'
import {
  bridgeRecordFile,
  pidAlive,
  readBridgeRecord,
  removeBridgeRecord,
  writeBridgeRecord
} from './hpc-bridge-record'

let home: string
let athenaDir: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'athena-bridge-record-'))
  athenaDir = path.join(home, 'hermes', 'athena')
  mkdirSync(athenaDir, { recursive: true })
})

afterEach(() => rmSync(home, { force: true, recursive: true }))

const put = (record: unknown) =>
  writeFileSync(bridgeRecordFile(athenaDir), typeof record === 'string' ? record : JSON.stringify(record))

/** A pid that named a process a moment ago and names none now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])

  return child.pid
}

describe('reading the bridge record', () => {
  const live = { address: '127.0.0.1', connected_at: '2026-11-13T20:00:00Z', pid: process.pid, port: 49731, version: 1 }

  test("athena's format reads back: address, port, pid, when it connected; unknown keys ignored", () => {
    put({ ...live, something_new: true })

    expect(readBridgeRecord(athenaDir)).toEqual({
      address: '127.0.0.1',
      connectedAt: '2026-11-13T20:00:00Z',
      pid: process.pid,
      port: 49731
    })
    put({ address: '::1', pid: process.pid, port: 1 })
    expect(readBridgeRecord(athenaDir)).toEqual({ address: '::1', connectedAt: null, pid: process.pid, port: 1 })
  })

  test.each([
    ['not JSON', '{'],
    ['not an object', [live]],
    ['an address off the laptop', { ...live, address: '10.0.0.5' }],
    ['a host name', { ...live, address: 'login5.ccm.sickkids.ca' }],
    ['port 0', { ...live, port: 0 }],
    ['a port out of range', { ...live, port: 65536 }],
    ['a port that is not a number', { ...live, port: '49731' }],
    ['a fractional port', { ...live, port: 49731.5 }],
    ['no pid', { address: '127.0.0.1', port: 49731 }],
    ['a pid that is not a number', { ...live, pid: true }]
  ])('stale means absent: %s', (_name, record) => {
    put(record)

    expect(readBridgeRecord(athenaDir)).toBeNull()
  })

  test('no file, and a record whose process is gone, read as none', () => {
    expect(readBridgeRecord(athenaDir)).toBeNull()

    const gone = deadPid()
    expect(pidAlive(gone)).toBe(false)
    expect(pidAlive(process.pid)).toBe(true)
    put({ ...live, pid: gone })
    expect(readBridgeRecord(athenaDir)).toBeNull()
  })
})

describe('writing the bridge record', () => {
  test('what main writes is what athena documents, and reads back as live', () => {
    const file = writeBridgeRecord(athenaDir, { port: 49731 })
    const written = JSON.parse(readFileSync(file, 'utf8'))

    expect(written).toEqual({
      address: '127.0.0.1',
      connected_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      pid: process.pid,
      port: 49731,
      version: 1
    })
    expect(readBridgeRecord(athenaDir)).toMatchObject({ pid: process.pid, port: 49731 })
    // No temporary file is left beside it.
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)

    removeBridgeRecord(athenaDir)
    expect(existsSync(file)).toBe(false)
    // Removing a record that is not there is fine.
    removeBridgeRecord(athenaDir)
  })

  // Windows has no owner-only mode bits: the Profile folder's ACL is what protects the file there.
  test.skipIf(process.platform === 'win32')('the record is private to the user (0600)', () => {
    const file = writeBridgeRecord(athenaDir, { port: 49731 })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('an address off the laptop is never written', () => {
    expect(() => writeBridgeRecord(athenaDir, { address: '0.0.0.0', port: 49731 })).toThrow(/loopback only/)
    expect(existsSync(bridgeRecordFile(athenaDir))).toBe(false)
  })
})

describe('the client-config snapshot follows the bridge', () => {
  test('a live record is in the snapshot; with none the key is absent', () => {
    expect('hpcBridge' in new AthenaClientConfig({ athenaDir }).snapshot()).toBe(false)

    writeBridgeRecord(athenaDir, { connectedAt: '2026-11-13T20:00:00Z', port: 49731 })
    expect(new AthenaClientConfig({ athenaDir }).snapshot().hpcBridge).toEqual({
      address: '127.0.0.1',
      connectedAt: '2026-11-13T20:00:00Z',
      port: 49731
    })
  })

  test('the poll pushes a snapshot when the bridge comes up, when it goes, and when its process dies', () => {
    const seen: ClientConfigSnapshot[] = []
    const source = new AthenaClientConfig({ athenaDir, onChange: snapshot => seen.push(snapshot) })
    source.start(60_000)

    try {
      source.tick()
      expect(seen).toEqual([])

      writeBridgeRecord(athenaDir, { port: 49731 })
      source.tick()
      expect(seen.map(snapshot => snapshot.hpcBridge?.port)).toEqual([49731])
      source.tick()
      expect(seen).toHaveLength(1)

      removeBridgeRecord(athenaDir)
      source.tick()
      expect(seen.map(snapshot => snapshot.hpcBridge?.port)).toEqual([49731, undefined])

      // A Desktop that crashed leaves the file: once its pid is gone the bridge is gone too.
      writeBridgeRecord(athenaDir, { pid: deadPid(), port: 49731 })
      source.tick()
      expect(seen).toHaveLength(2)
      expect(source.snapshot().hpcBridge).toBeUndefined()
    } finally {
      source.stop()
    }
  })
})
