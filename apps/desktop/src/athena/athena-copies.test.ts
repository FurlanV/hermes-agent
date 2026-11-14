// @vitest-environment node
// The bundled athena copies match src/athena/athena-copies.json (scripts/athena-copies.mjs), and a packed app
// is checked for the Athena name, icon, keys and catalog (scripts/check-packed-app.mjs). Both scripts run in
// the Windows build workflow; they are spawned here the way CI runs them.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { TRUSTED_KEYS } from '../../electron/athena/bundled-config-data'

import BRANDING from './branding.json'
import CATALOG from './catalog/catalog.json'

const desktop = path.resolve(import.meta.dirname, '../..')
const repo = path.resolve(desktop, '../..')
const copiesScript = path.join(desktop, 'src/athena/scripts/athena-copies.mjs')
const packedScript = path.join(desktop, 'src/athena/scripts/check-packed-app.mjs')
const athenaRepo = process.env.ATHENA_REPO ?? path.join(homedir(), 'Documents/Projects/sickkids/athena')
const MANIFEST = 'apps/desktop/src/athena/athena-copies.json'

const COPIES = [
  'apps/desktop/src/athena/catalog/catalog.json',
  'apps/desktop/electron/athena/bundled-config-data.ts',
  'apps/desktop/electron/athena/features.json'
]

const temps: string[] = []

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'athena-copies-'))
  temps.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** A fork tree holding only the manifest and the copies, with `edit` applied to one of them. */
function forkTree(edit?: { file: string; change: (text: string) => string }): string {
  const root = temp()

  for (const file of [MANIFEST, ...COPIES]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    const text = readFileSync(path.join(repo, file), 'utf8')
    writeFileSync(path.join(root, file), edit?.file === file ? edit.change(text) : text)
  }

  return root
}

describe('bundled athena copies', () => {
  test('match the manifest in this checkout', () => {
    expect(run(copiesScript, ['--check'])).toMatchObject({ status: 0 })
  })

  test('a byte change to a byte copy fails the check', () => {
    const root = forkTree({ file: COPIES[0], change: text => `${text}\n` })
    const result = run(copiesScript, ['--check', '--root', root])

    expect(result.status).toBe(1)
    expect(result.output).toContain('src/athena/catalog/catalog.json differs from athena client/catalog/catalog.json')
  })

  test('the embedded trusted keys are compared as JSON: a new kid fails, reformatting does not', () => {
    const kid = TRUSTED_KEYS.keys[0].kid

    const changed = run(copiesScript, [
      '--check',
      '--root',
      forkTree({ file: COPIES[1], change: text => text.replace(kid, `${kid}x`) })
    ])

    expect(changed.status).toBe(1)
    expect(changed.output).toContain('bundled-config-data.ts (TRUSTED_KEYS) differs from athena')

    const reformatted = forkTree({ file: COPIES[1], change: text => text.replaceAll('\n    ', '\n\t') })

    expect(run(copiesScript, ['--check', '--root', reformatted])).toMatchObject({ status: 0 })
  })

  test('a manifest that drops a copy fails the check', () => {
    const root = forkTree({
      file: MANIFEST,
      change: text => {
        const doc = JSON.parse(text)
        doc.files = doc.files.filter((file: { copy: string }) => !file.copy.endsWith('features.json'))

        return JSON.stringify(doc)
      }
    })

    expect(run(copiesScript, ['--check', '--root', root]).output).toContain('does not list shared/athena_schemas')
  })

  test.skipIf(!existsSync(path.join(athenaRepo, 'client/catalog/catalog.json')))('match the athena checkout', () => {
    const result = run(copiesScript, ['--check', '--athena', athenaRepo])

    expect(result.output).toContain('match')
    expect(result.status).toBe(0)
  })
})

/** A packed-app layout: install stamp and built bundles, plus an exe for Windows. */
function packedApp({
  windows,
  brand = 'athena',
  bundle
}: {
  windows: boolean
  brand?: string
  bundle?: string
}): string {
  const app = windows ? temp() : path.join(temp(), 'Athena.app')
  const resources = windows ? path.join(app, 'resources') : path.join(app, 'Contents', 'Resources')

  const needles = [
    ...TRUSTED_KEYS.keys.flatMap(key => [key.kid, key.x]),
    CATALOG.catalog_version,
    ...Object.values(CATALOG.entries).map(entry => entry.sha256)
  ]

  mkdirSync(path.join(resources, 'app.asar.unpacked', 'dist', 'assets'), { recursive: true })
  writeFileSync(path.join(resources, 'install-stamp.json'), JSON.stringify({ brand }))
  writeFileSync(
    path.join(resources, 'app.asar.unpacked', 'dist', 'assets', 'chunk.js'),
    bundle ?? JSON.stringify(needles)
  )

  return app
}

const rcedit = path.join(desktop, 'node_modules/rcedit/bin/rcedit-x64.exe')

/** Stamp a copy of a real Windows PE with an icon and version strings, the way rcedit stamps Athena.exe. */
function stampExe(out: string, { ico, product }: { ico: string; product: string }) {
  const builder = realpathSync(path.join(desktop, 'node_modules/app-builder-lib'))
  const resedit = createRequire(path.join(builder, 'package.json'))('resedit')
  const exe = resedit.NtExecutable.from(readFileSync(rcedit), { ignoreCert: true })
  const resources = resedit.NtExecutableResource.from(exe)
  const icons = resedit.Data.IconFile.from(readFileSync(ico)).icons.map((icon: { data: unknown }) => icon.data)

  resedit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icons)
  const version = resedit.Resource.VersionInfo.fromEntries(resources.entries)[0]

  version.setStringValues(
    { lang: 1033, codepage: 1200 },
    { ProductName: product, FileDescription: product, CompanyName: BRANDING.organization }
  )
  version.outputToResourceEntries(resources.entries)
  resources.outputResource(exe)
  writeFileSync(out, Buffer.from(exe.generate()))
}

describe('packed app check', () => {
  test('a macOS app with the Athena stamp, keys and catalog passes', () => {
    expect(run(packedScript, [packedApp({ windows: false })])).toMatchObject({ status: 0 })
  })

  test('a stock stamp or a bundle without the keys fails', () => {
    expect(run(packedScript, [packedApp({ windows: false, brand: 'hermes' })]).output).toContain('brand is hermes')
    expect(run(packedScript, [packedApp({ windows: false, bundle: 'nothing' })]).output).toContain('trusted key kid')
  })

  test.skipIf(!existsSync(rcedit))(
    'a Windows exe passes only with the Athena name and icon',
    () => {
      const icon = path.join(desktop, 'assets/icon.ico')
      const good = packedApp({ windows: true })

      stampExe(path.join(good, `${BRANDING.display}.exe`), { ico: icon, product: BRANDING.display })
      expect(run(packedScript, [good])).toMatchObject({ status: 0 })

      const renamed = packedApp({ windows: true })

      stampExe(path.join(renamed, `${BRANDING.display}.exe`), { ico: icon, product: 'Hermes' })
      expect(run(packedScript, [renamed]).output).toContain('ProductName is Hermes')

      const otherIcon = packedApp({ windows: true })

      stampExe(path.join(otherIcon, `${BRANDING.display}.exe`), {
        ico: path.join(desktop, 'assets/icon-dark.ico'),
        product: BRANDING.display
      })
      expect(run(packedScript, [otherIcon]).output).toContain('icon (')

      const stock = packedApp({ windows: true })

      cpSync(path.join(good, `${BRANDING.display}.exe`), path.join(stock, `${BRANDING.display}.exe`))
      writeFileSync(path.join(stock, 'electron.exe'), '')
      expect(run(packedScript, [stock]).output).toContain('electron.exe is in the app folder')
      // Four spawned checks, each parsing a real PE.
    },
    60_000
  )
})
