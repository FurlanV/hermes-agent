#!/usr/bin/env node
// The athena files this build bundles, and src/athena/athena-copies.json, the manifest that records the
// sha256 of each athena source. The fork is public and athena is private, so the fork's CI cannot read
// athena: the manifest is athena's side of the comparison. athena's CI checks its own files against the
// same manifest (fetched from the fork commit hermes.lock pins), so a copy that drifts on either side fails.
//
//   node athena-copies.mjs --check                exit 1 when a fork copy differs from the manifest
//   node athena-copies.mjs --check --athena DIR   ...or when an athena file differs from it
//   node athena-copies.mjs --write [--athena DIR] rewrite the manifest from the athena checkout
//
// --athena defaults to $ATHENA_REPO, else ~/Documents/Projects/sickkids/athena; --check reads it only when
// given. --root is the fork checkout (default: the one this script is in).
//
// A `bytes` copy is a byte copy of the athena file; its sha256 is compared. A `json` copy is athena's JSON
// embedded in TypeScript (one named export); its canonical JSON (canonicalJson below) is hashed and compared
// with `json_sha256`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const DATA = 'shared/athena_schemas/src/athena_schemas/data'
const MANIFEST = 'apps/desktop/src/athena/athena-copies.json'

/** Every athena file the Desktop bundles: [athena path, fork copy, compare, TypeScript export]. */
export const COPIES = [
  { athena: 'client/catalog/catalog.json', copy: 'apps/desktop/src/athena/catalog/catalog.json', compare: 'bytes' },
  {
    athena: `${DATA}/trusted-keys.json`,
    copy: 'apps/desktop/electron/athena/bundled-config-data.ts',
    compare: 'json',
    export: 'TRUSTED_KEYS'
  },
  {
    athena: `${DATA}/client-config.default.json`,
    copy: 'apps/desktop/electron/athena/bundled-config-data.ts',
    compare: 'json',
    export: 'BUNDLED_DEFAULT_CONFIG'
  },
  { athena: `${DATA}/features.json`, copy: 'apps/desktop/electron/athena/features.json', compare: 'bytes' }
]

const sha256 = data => createHash('sha256').update(data).digest('hex')

/**
 * JSON with object keys sorted, no whitespace, UTF-8. Python's equivalent is
 * json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode(). The two agree for
 * the data these files hold (strings, integers, booleans, null); they differ on non-integer floats.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The digests of one athena file, as the manifest records them. */
function athenaDigests(entry, athenaRoot) {
  const bytes = readFileSync(path.join(athenaRoot, entry.athena))
  return {
    sha256: sha256(bytes),
    ...(entry.compare === 'json' ? { json_sha256: sha256(canonicalJson(JSON.parse(bytes.toString('utf8')))) } : {})
  }
}

/** The digest of the fork's copy, keyed like the manifest field it is compared with. */
async function copyDigest(entry, root) {
  const file = path.join(root, entry.copy)
  if (entry.compare === 'bytes') return { field: 'sha256', value: sha256(readFileSync(file)) }
  // Node strips the TypeScript types (Node >= 22.18); the module holds only data.
  const module = await import(pathToFileURL(file).href)
  if (!(entry.export in module)) throw new Error(`${entry.copy} has no export ${entry.export}`)
  return { field: 'json_sha256', value: sha256(canonicalJson(module[entry.export])) }
}

const label = entry => (entry.export ? `${entry.copy} (${entry.export})` : entry.copy)

/** Problems with the manifest, the fork copies and (when given) the athena files. Empty means all equal. */
export async function checkCopies({ root, athena = null }) {
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'))
  const problems = []
  const recorded = new Map((manifest.files ?? []).map(file => [file.athena, file]))
  const expected = new Set(COPIES.map(entry => entry.athena))

  for (const name of recorded.keys()) {
    if (!expected.has(name)) problems.push(`${MANIFEST} lists ${name}, which is not a bundled copy`)
  }

  for (const entry of COPIES) {
    const file = recorded.get(entry.athena)
    if (!file) {
      problems.push(`${MANIFEST} does not list ${entry.athena}`)
      continue
    }
    if (
      file.copy !== entry.copy ||
      file.compare !== entry.compare ||
      (file.export ?? null) !== (entry.export ?? null)
    ) {
      problems.push(`${MANIFEST}: the entry for ${entry.athena} does not describe ${label(entry)} (${entry.compare})`)
      continue
    }

    const { field, value } = await copyDigest(entry, root)
    if (file[field] !== value) {
      problems.push(`${label(entry)} differs from athena ${entry.athena} (${field} ${value}, manifest ${file[field]})`)
    }

    if (athena) {
      const digests = athenaDigests(entry, athena)
      for (const [key, digest] of Object.entries(digests)) {
        if (file[key] !== digest)
          problems.push(`athena ${entry.athena} differs from ${MANIFEST} (${key} ${digest}, manifest ${file[key]})`)
      }
    }
  }

  return problems
}

/** The manifest for the athena checkout at `athena`. */
export function manifestFor(athena) {
  let commit = null
  try {
    commit = execFileSync('git', ['-C', athena, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    // Not a git checkout: the hashes still stand.
  }

  return {
    about:
      'sha256 of each athena file the Desktop bundles, and of its canonical JSON where the copy is embedded in TypeScript. Written by `node apps/desktop/src/athena/scripts/athena-copies.mjs --write`; `--check` (and the Windows build workflow) fail when a fork copy differs, athena CI when an athena file does.',
    schema_version: 1,
    athena_repo: 'FurlanV/athena',
    athena_commit: commit,
    canonical_json: "json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False), UTF-8",
    files: COPIES.map(entry => ({ ...entry, ...athenaDigests(entry, athena) }))
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      athena: { type: 'string' },
      root: { type: 'string' }
    }
  })
  const root = path.resolve(values.root ?? path.join(import.meta.dirname, '../../../../..'))

  if (values.write === values.check) {
    console.error('usage: athena-copies.mjs --check [--athena DIR] | --write [--athena DIR]  [--root FORK]')
    return 2
  }

  const athena = values.write
    ? path.resolve(
        values.athena ?? process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
      )
    : values.athena
      ? path.resolve(values.athena)
      : null
  if (values.write) {
    writeFileSync(path.join(root, MANIFEST), `${JSON.stringify(manifestFor(athena), null, 2)}\n`)
    console.log(`athena-copies: wrote ${MANIFEST} from ${athena}`)
  }

  const problems = await checkCopies({ root, athena })
  for (const problem of problems) console.error(`athena-copies: ${problem}`)
  if (problems.length) {
    console.error('athena-copies: copy the athena files into the fork, then run --write with the athena checkout')
    return 1
  }
  console.log(`athena-copies: ${COPIES.length} bundled copies match ${MANIFEST}${athena ? ` and ${athena}` : ''}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
