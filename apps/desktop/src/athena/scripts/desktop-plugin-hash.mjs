#!/usr/bin/env node
// The sha256 of the Athena desktop plugin, for the build's allowlist (F02 slice 29,
// src/athena/managed/desktop-plugins.json). It builds athena's client/desktop-plugins/athena with athena's own
// build.mjs and pinned esbuild, in a temporary copy (the athena checkout is not written), and hashes
// dist/athena/plugin.js, the file the installer copies to $HERMES_HOME/desktop-plugins/athena/plugin.js.
//
//   node desktop-plugin-hash.mjs           print the hash
//   node desktop-plugin-hash.mjs --check   exit 1 when desktop-plugins.json does not list it
//   node desktop-plugin-hash.mjs --write   make it the only hash listed for "athena"
//
// ATHENA_REPO points at the athena checkout (default ~/Documents/Projects/sickkids/athena); it needs
// `npm install` done in client/desktop-plugins/athena.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const allowlistFile = path.resolve(here, '../managed/desktop-plugins.json')
const athenaRepo = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const pluginDir = path.join(athenaRepo, 'client/desktop-plugins/athena')

function buildAndHash() {
  if (!existsSync(path.join(pluginDir, 'node_modules', 'esbuild'))) {
    throw new Error(`no built toolchain at ${pluginDir} (run npm install there, or set ATHENA_REPO)`)
  }

  const work = mkdtempSync(path.join(tmpdir(), 'athena-desktop-plugin-'))

  try {
    for (const entry of ['build.mjs', 'package.json', 'tsconfig.json', 'src']) {
      cpSync(path.join(pluginDir, entry), path.join(work, entry), { recursive: true })
    }

    symlinkSync(path.join(pluginDir, 'node_modules'), path.join(work, 'node_modules'), 'dir')
    execFileSync(process.execPath, ['build.mjs'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })

    return createHash('sha256').update(readFileSync(path.join(work, 'dist/athena/plugin.js'))).digest('hex')
  } finally {
    rmSync(work, { force: true, recursive: true })
  }
}

const hash = buildAndHash()
const allowlist = JSON.parse(readFileSync(allowlistFile, 'utf8'))
const athena = allowlist.plugins.find(plugin => plugin.id === 'athena')

if (process.argv.includes('--write')) {
  athena.sha256 = [hash]
  writeFileSync(allowlistFile, `${JSON.stringify(allowlist, null, 2)}\n`)
  console.log(`desktop-plugins.json: athena ${hash}`)
} else if (process.argv.includes('--check')) {
  if (!athena?.sha256.includes(hash)) {
    console.error(`desktop-plugins.json is stale: the athena plugin builds to ${hash} (run with --write)`)
    process.exit(1)
  }

  console.log(`desktop-plugins.json lists the athena plugin (${hash})`)
} else {
  console.log(hash)
}
