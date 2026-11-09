// Test helper (F02 slice 17): one concrete call per backend entry a registry row lists, so the table-driven tests
// in main (REST, IPC, DevTools) and the renderer (JSON-RPC) send every surface of every row directly.

import { FEATURE_ROWS, type FeatureRow } from './feature-registry'

export type SurfaceCall =
  | { body?: unknown; entry: string; kind: 'rest'; method: string; path: string }
  | { channel: string; entry: string; kind: 'ipc' }
  | { entry: string; kind: 'devtools' }
  | { entry: string; kind: 'rpc'; method: string; params: Record<string, unknown> }

const PROBE = 'athena-probe'
const fill = (pattern: string, probe = PROBE) => (pattern.endsWith('*') ? `${pattern.slice(0, -1)}${probe}` : pattern)

/** The call that reaches `entry`, or null for an entry that is not a backend surface. */
export function callForEntry(entry: string): null | SurfaceCall {
  if (entry.startsWith('rest:')) {
    const spec = entry.slice('rest:'.length)
    const [first, ...rest] = spec.split(' ')
    const path = fill(rest.length ? rest.join(' ') : first)
    const method = rest.length ? (first === 'WRITE' ? 'PUT' : first) : 'GET'

    return { entry, kind: 'rest', method, path }
  }

  if (entry.startsWith('rpc:')) {
    const [method, action] = fill(entry.slice('rpc:'.length), 'probe').split('/')
    const params: Record<string, unknown> = {}

    if (action) {
      if (method === 'config.set') {
        params.key = action
      } else if (method === 'command.dispatch') {
        params.name = action
      } else {
        params.action = action
      }
    }

    return { entry, kind: 'rpc', method, params }
  }

  if (entry.startsWith('slash:')) {
    return { entry, kind: 'rpc', method: 'command.dispatch', params: { name: entry.slice('slash:'.length) } }
  }

  if (entry.startsWith('ipc:')) {
    return { channel: fill(entry.slice('ipc:'.length), 'probe'), entry, kind: 'ipc' }
  }

  if (entry.startsWith('env:') || entry.startsWith('credential:')) {
    const key = fill(entry.slice(entry.indexOf(':') + 1), entry.startsWith('env:') ? 'OPENAI_API_KEY' : 'PROBE')

    return { body: { key, value: 'x' }, entry, kind: 'rest', method: 'PUT', path: '/api/env' }
  }

  if (entry === 'devtools:open') {
    return { entry, kind: 'devtools' }
  }

  return null
}

export interface RowSurfaces {
  calls: SurfaceCall[]
  row: FeatureRow
}

/** Every row with at least one backend surface of the given kinds, and those calls. */
export function rowSurfaces(kinds: readonly SurfaceCall['kind'][]): RowSurfaces[] {
  return FEATURE_ROWS.map(row => ({
    calls: row.entries.map(callForEntry).filter((call): call is SurfaceCall => call !== null && kinds.includes(call.kind)),
    row
  })).filter(({ calls }) => calls.length > 0)
}
