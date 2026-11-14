#!/usr/bin/env node
// Check that a packed Athena Desktop is the Athena variant, not stock Hermes:
//
//   node check-packed-app.mjs apps/desktop/release/win-unpacked             Windows unpacked folder
//   node check-packed-app.mjs apps/desktop/release/mac-arm64/Athena.app     macOS app (no exe checks)
//
// - the install stamp says `brand: athena`;
// - the built bundles (resources/app.asar.unpacked/dist) carry every bundled trusted key (kid and x) and the
//   bundled catalog (its version and every entry's sha256), the copies athena-copies.mjs checks;
// - Windows: `<display>.exe` exists and no Hermes.exe or electron.exe; its version strings name Athena and
//   SickKids (branding.json); its icon is exactly assets/icon.ico (image for image), and that file is not the
//   stock Hermes icon.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const desktop = path.resolve(import.meta.dirname, '../../..')
const branding = JSON.parse(readFileSync(path.join(desktop, 'src/athena/branding.json'), 'utf8'))

// apps/desktop/assets/icon.ico before the Athena icons (upstream 071d31ffc69 and f9be9b5b6d^).
export const STOCK_HERMES_ICON_SHA256 = '41bfca2371bc0e6159038c7c78dd39f29c6272038b4a2ce38be2a568203d5f98'

const RT_ICON = 3
const sha256 = data => createHash('sha256').update(data).digest('hex')

/** resedit, the PE resource library electron-builder itself uses (app-builder-lib's dependency). */
function loadResedit() {
  const builder = realpathSync(path.join(desktop, 'node_modules/app-builder-lib'))
  return createRequire(path.join(builder, 'package.json'))('resedit')
}

/** sha256 of each image in an .ico file, in directory order. */
export function icoImageDigests(ico) {
  const count = ico.readUInt16LE(4)
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || count === 0) throw new Error('not an .ico file')
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + 16 * index
    const size = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    return sha256(ico.subarray(offset, offset + size))
  })
}

/** The exe's version strings and the sha256 of each image in its first icon group. */
export function exeIdentity(exe, resedit = loadResedit()) {
  const binary = readFileSync(exe)
  const executable = resedit.NtExecutable.from(binary, { ignoreCert: true })
  const { entries } = resedit.NtExecutableResource.from(executable)
  const [version] = resedit.Resource.VersionInfo.fromEntries(entries)
  const [language] = version?.getAllLanguagesForStringValues() ?? []
  const strings = language ? version.getStringValues(language) : {}
  const [group] = resedit.Resource.IconGroupEntry.fromEntries(entries)
  const icons = (group?.icons ?? []).map(icon => {
    const image = entries.find(entry => entry.type === RT_ICON && entry.id === icon.iconID)
    return image ? sha256(Buffer.from(image.bin)) : `missing RT_ICON ${icon.iconID}`
  })
  return { strings, icons }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

/** Problems with the packed app at `app`. Empty means it is the Athena variant. */
export async function checkPackedApp(app) {
  const problems = []
  const windows = existsSync(path.join(app, 'resources'))
  const resources = windows ? path.join(app, 'resources') : path.join(app, 'Contents', 'Resources')
  if (!existsSync(resources)) return [`${app} has neither resources/ (Windows) nor Contents/Resources (macOS)`]

  const stamp = JSON.parse(readFileSync(path.join(resources, 'install-stamp.json'), 'utf8'))
  if (stamp.brand !== 'athena') problems.push(`install-stamp.json brand is ${stamp.brand}, not athena`)

  const dist = path.join(resources, 'app.asar.unpacked', 'dist')
  if (!existsSync(dist)) {
    problems.push(`${dist} is missing (the built bundles are no longer unpacked from the asar)`)
  } else {
    const bundles = walk(dist)
      .filter(file => /\.(?:c|m)?js$/.test(file))
      .map(file => readFileSync(file, 'utf8'))
      .join('\n')
    const { TRUSTED_KEYS } = await import(
      pathToFileURL(path.join(desktop, 'electron/athena/bundled-config-data.ts')).href
    )
    const catalog = JSON.parse(readFileSync(path.join(desktop, 'src/athena/catalog/catalog.json'), 'utf8'))
    const needles = [
      ...TRUSTED_KEYS.keys.flatMap(key => [
        [`trusted key kid ${key.kid}`, key.kid],
        [`trusted key x of ${key.kid}`, key.x]
      ]),
      [`catalog_version ${catalog.catalog_version}`, catalog.catalog_version],
      ...Object.entries(catalog.entries).map(([id, entry]) => [`catalog entry ${id} sha256`, entry.sha256])
    ]
    for (const [what, needle] of needles) {
      if (!bundles.includes(needle)) problems.push(`the built bundles do not carry the ${what}`)
    }
  }

  if (!windows) return problems

  const exe = path.join(app, `${branding.display}.exe`)
  for (const stock of ['Hermes.exe', 'electron.exe']) {
    if (existsSync(path.join(app, stock))) problems.push(`${stock} is in the app folder`)
  }
  if (!existsSync(exe)) return [...problems, `${exe} is missing`]

  const { strings, icons } = exeIdentity(exe)
  const expected = {
    ProductName: branding.display,
    FileDescription: branding.display,
    CompanyName: branding.organization
  }
  for (const [key, value] of Object.entries(expected)) {
    if (strings[key] !== value) problems.push(`${branding.display}.exe ${key} is ${strings[key]}, not ${value}`)
  }

  const ico = readFileSync(path.join(desktop, 'assets/icon.ico'))
  if (sha256(ico) === STOCK_HERMES_ICON_SHA256) problems.push('assets/icon.ico is the stock Hermes icon')
  const images = icoImageDigests(ico)
  if (icons.toSorted().join() !== images.toSorted().join()) {
    problems.push(
      `${branding.display}.exe icon (${icons.length} images) is not assets/icon.ico (${images.length} images)`
    )
  }

  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = process.argv[2]
  if (!app) {
    console.error('usage: check-packed-app.mjs <unpacked app folder | .app>')
    process.exit(2)
  }
  const problems = await checkPackedApp(path.resolve(app))
  for (const problem of problems) console.error(`check-packed-app: ${problem}`)
  if (problems.length) process.exit(1)
  console.log(`check-packed-app: ${app} is the ${branding.display} variant`)
}
