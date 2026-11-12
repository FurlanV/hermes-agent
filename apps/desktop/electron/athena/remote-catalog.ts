// Athena: the signed remote catalog's rules in Electron main (F03 slice 19). A copy of the athena repo's
// `athena_schemas.remote_catalog` (and the guard's stdlib copy); `remote-catalog.test.ts` checks the same cases.
//
// Main re-verifies `$HERMES_HOME/athena/catalog.jws` itself with the trusted keys the app bundles: `typ`
// `athena-catalog+jws`, `aud: athena-desktop`, schema major 1, a `catalog_version` not below the highest any reader
// accepted (the shipper's `catalog.state.json` `high_water` and main's own `desktop-catalog.json`), at most 7 days
// past `expires_at`. Of its entries it takes only `gateway` and `skill` packages whose `category` is not `built-in`,
// whose `sha256` is that of their canonical JSON, whose skills (if any) are delivered as allowed text files hashing to
// the entry's `sha256`, and (skill packages) that provide nothing but `skills_list`/`skill_view`. Everything else is
// refused with a reason. The renderer, which holds the bundled catalog, also drops any id that is a bundled built-in.

import { createHash, type KeyObject } from 'node:crypto'

import { JwsError, verifyCompactJws } from './jws'

export const CATALOG_TYP = 'athena-catalog+jws'
export const CATALOG_AUDIENCE = 'athena-desktop'
export const CATALOG_SCHEMA_MAJOR = 1
export const CATALOG_GRACE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_SKILL_BYTES = 256 * 1024
export const MAX_SKILL_FILES = 32
export const SKILL_SUFFIXES = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv'] as const
const REMOTE_KINDS = new Set(['gateway', 'skill'])
const SKILL_TOOLSETS = new Set(['skills'])
const SKILL_TOOLS = new Set(['skill_view', 'skills_list'])

export type RemoteRejection =
  | 'built_in'
  | 'entry_hash_mismatch'
  | 'invalid'
  | 'kind_not_allowed'
  | 'provides_not_allowed'
  | 'skill_file_not_allowed'
  | 'skill_hash_mismatch'
  | 'skill_missing'

export class CatalogRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The bytes the platform signs and hashes: Python's `json.dumps(sort_keys=True, separators=(',', ':'))`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** `folder_sha256` of a folder holding exactly `files`. */
export function filesSha256(files: Record<string, string>): string {
  const lines = Object.entries(files)
    .map(([rel, text]) => `${rel}\0${sha256(text)}\n`)
    .sort()

  return sha256(lines.join(''))
}

/** `YYYY.M.N` as numbers, or null. */
export function versionTuple(version: unknown): null | number[] {
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) {
    return null
  }

  return version.split('.').map(Number)
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)

    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

export interface RemoteCatalogDocument {
  catalog_version: string
  entries: Record<string, Record<string, unknown>>
  expires_at: string
  skills: Record<string, { files?: unknown }>
  [key: string]: unknown
}

/** Verify one signed remote catalog; `floor`: the highest version accepted so far (or null). */
export function verifyRemoteCatalog(
  token: string,
  trusted: ReadonlyMap<string, KeyObject>,
  floor: null | string,
  now: number
): RemoteCatalogDocument {
  if (token.length > MAX_DOCUMENT_BYTES * 2) {
    throw new CatalogRefused('too_large')
  }

  let verified

  try {
    verified = verifyCompactJws(token.trim(), trusted)
  } catch (error) {
    if (error instanceof JwsError) {
      throw new CatalogRefused(error.reason)
    }

    throw error
  }

  if (verified.header.typ !== CATALOG_TYP) {
    throw new CatalogRefused('wrong_typ')
  }

  let data: unknown

  try {
    data = JSON.parse(verified.payload.toString('utf8'))
  } catch {
    throw new CatalogRefused('bad_payload')
  }

  if (!isRecord(data) || !isRecord(data.entries)) {
    throw new CatalogRefused('bad_payload')
  }

  const head = String(data.schema_version).split('.', 1)[0]

  if (!/^\d+$/.test(head)) {
    throw new CatalogRefused('bad_payload')
  }

  if (Number(head) > CATALOG_SCHEMA_MAJOR) {
    throw new CatalogRefused('schema_too_new')
  }

  if (data.aud !== CATALOG_AUDIENCE) {
    throw new CatalogRefused('wrong_audience')
  }

  const version = versionTuple(data.catalog_version)
  const floorTuple = versionTuple(floor)

  if (!version) {
    throw new CatalogRefused('bad_payload')
  }

  if (floorTuple && compareVersions(version, floorTuple) < 0) {
    throw new CatalogRefused('replayed_version')
  }

  const expires = Date.parse(String(data.expires_at))

  if (Number.isNaN(expires)) {
    throw new CatalogRefused('bad_payload')
  }

  if (now > expires + CATALOG_GRACE_MS) {
    throw new CatalogRefused('last_good_expired')
  }

  return { ...data, skills: isRecord(data.skills) ? (data.skills as RemoteCatalogDocument['skills']) : {} } as RemoteCatalogDocument
}

function fileOk(rel: string): boolean {
  const parts = rel.split('/')

  return (
    Boolean(rel) &&
    !rel.startsWith('/') &&
    parts.every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')) &&
    /^[A-Za-z0-9._\-/]+$/.test(rel) &&
    SKILL_SUFFIXES.some(suffix => rel.endsWith(suffix))
  )
}

function skillOk(files: unknown): files is Record<string, string> {
  if (!isRecord(files)) {
    return false
  }

  const values = Object.values(files)

  return (
    values.length > 0 &&
    values.length <= MAX_SKILL_FILES &&
    'SKILL.md' in files &&
    values.every(value => typeof value === 'string') &&
    values.reduce((total: number, value) => total + Buffer.byteLength(value as string, 'utf8'), 0) <= MAX_SKILL_BYTES &&
    Object.keys(files).every(fileOk)
  )
}

function skillHashes(raw: Record<string, unknown>): unknown[] {
  const out: unknown[] = []

  if (raw.kind === 'skill') {
    out.push(isRecord(raw.source) ? raw.source.sha256 : null)
  }

  if (raw.skill !== undefined && raw.skill !== null) {
    out.push(isRecord(raw.skill) ? raw.skill.sha256 : null)
  }

  return out
}

/** Why main refuses one remote entry, else null (the built-in-by-id check is the renderer's). */
export function remoteRefusal(id: string, raw: unknown, skills: RemoteCatalogDocument['skills']): null | RemoteRejection {
  if (!isRecord(raw)) {
    return 'invalid'
  }

  if ((raw.category ?? 'built-in') === 'built-in') {
    return 'built_in'
  }

  if (!REMOTE_KINDS.has(String(raw.kind))) {
    return 'kind_not_allowed'
  }

  if (raw.id !== id) {
    return 'invalid'
  }

  const { sha256: stated, ...rest } = raw

  if (stated !== sha256(canonicalJson(rest))) {
    return 'entry_hash_mismatch'
  }

  const provides = isRecord(raw.provides) ? raw.provides : {}
  const listed = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])

  if (
    raw.kind === 'skill' &&
    !(listed(provides.toolsets).every(t => SKILL_TOOLSETS.has(t)) && listed(provides.tools).every(t => SKILL_TOOLS.has(t)))
  ) {
    return 'provides_not_allowed'
  }

  for (const hash of skillHashes(raw)) {
    const files = isRecord(skills[id]) ? skills[id].files : undefined

    if (files === undefined) {
      return 'skill_missing'
    }

    if (!skillOk(files)) {
      return 'skill_file_not_allowed'
    }

    if (filesSha256(files) !== hash) {
      return 'skill_hash_mismatch'
    }
  }

  return null
}

export interface RemoteAcceptance {
  accepted: Record<string, Record<string, unknown>>
  rejected: { id: string; reason: RemoteRejection }[]
}

export function acceptRemote(doc: RemoteCatalogDocument): RemoteAcceptance {
  const accepted: RemoteAcceptance['accepted'] = {}
  const rejected: RemoteAcceptance['rejected'] = []

  for (const [id, raw] of Object.entries(doc.entries).sort(([a], [b]) => a.localeCompare(b))) {
    const reason = remoteRefusal(id, raw, doc.skills)

    if (reason === null) {
      accepted[id] = raw
    } else {
      rejected.push({ id, reason })
    }
  }

  return { accepted, rejected }
}
