#!/usr/bin/env node
// Generate src/athena/nous-inventory.md: every Nous mention in apps/desktop,
// classified as replace / hide / keep under D05's substitution rules.
//
//   node src/athena/scripts/nous-inventory.mjs           rewrite the inventory
//   node src/athena/scripts/nous-inventory.mjs --check   fail if it is stale or a rule is broken
//
// Rows come from the upstream base (BASE below) so a replaced mention stays on
// record; rows the Athena branch adds are listed separately. --check fails
// when any mention is unclassified, a `replace` row is still present, or a
// current mention of "Nous Research", "Nous Portal" or "com.nousresearch" is
// not a keep or hide row. Re-run after every rebase onto a new hermes commit.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const BASE = '1a48bf2bf38bd881e0837e3192d2291de6184dc7'
const desktop = path.resolve(import.meta.dirname, '../../..')
const repo = path.resolve(desktop, '../..')
const out = path.join(desktop, 'src/athena/nous-inventory.md')

const PATTERN = 'nous research|nous portal|com\\.nousresearch|nousresearch\\.com|NousResearch/hermes-agent|nousresearch\\.github\\.io'
const STRICT = /nous research|nous portal|com\.nousresearch/i
// The inventory itself quotes every mention; it is a keep by construction.
const EXCLUDES = [':!apps/desktop/node_modules', ':!apps/desktop/dist', ':!apps/desktop/release', ':!apps/desktop/build',
  ':!apps/desktop/src/athena/nous-inventory.md']

// Status values: done (replaced on this branch), switch (hidden by
// athenaStrings.hideNousServices), policy (only shown for a Nous account or
// the Nous free tier, which the Athena profile never enables: nous.guest
// false), unreachable (a mode the Athena build never enters), p10 (off the
// demo path, not patched yet: follow-up under P10), n/a (keep).
const RULES = [
  // ── keep: not user-visible ─────────────────────────────────────────────
  [/\.(test|spec)\.|(^|\/)e2e\//, null, 'test fixture', 'keep', 'n/a'],
  [/LICENSE$/, null, 'licence notice', 'keep', 'n/a', 'MIT copyright notice must stay'],
  [/^apps\/desktop\/src\/athena\//, null, 'Athena branding files', 'keep', 'n/a', 'quotes the MIT credit, a stock value or a rule'],
  [/\.md$/, null, 'developer docs', 'keep', 'n/a', 'not packaged (builder `files` whitelist)'],
  [/./, /^\s*(\/\/|\/\*|\*)/, 'code comment', 'keep', 'n/a'],
  // ── identity, maker, publisher ─────────────────────────────────────────
  [/product-identity\.cjs$/, /com\.nousresearch/, 'app id (stock variants)', 'keep', 'n/a', 'athena → ca.sickkids.athena from branding.json'],
  [/product-identity\.cjs$/, /Nous Research Inc/, 'MSIX publisher (stock Store variant)', 'keep', 'n/a', 'Store variant only'],
  [/electron-builder\.config\.cjs$/, /GITHUB_REPOSITORY/, 'release feed repo', 'keep', 'n/a', 'athena publishes no feed'],
  [/electron-builder\.config\.cjs$/, /athena \? athena\.msixPublisherDisplayName : 'Nous Research'/, 'MSIX publisher (stock fallback)', 'keep', 'n/a', 'athena → branding.msixPublisherDisplayName'],
  [/electron-builder\.config\.cjs$/, /publisherDisplayName/, 'MSIX publisher', 'replace', 'done', 'branding.msixPublisherDisplayName'],
  [/electron-builder\.config\.cjs$/, /maintainer: athena/, 'Linux maintainer (stock fallback)', 'keep', 'n/a', 'athena → branding.organization'],
  [/electron-builder\.config\.cjs$/, /maintainer/, 'Linux maintainer', 'replace', 'done', 'branding.organization'],
  [/package\.json$/, /"author"/, 'package author', 'replace', 'done', '"SickKids"'],
  [/package\.json$/, /"copyright"/, 'copyright (credit)', 'keep', 'n/a', 'SickKids, crediting Hermes Agent © Nous Research (MIT)'],
  [/package\.json$/, /"url"/, 'package repository metadata', 'keep', 'n/a'],
  [/set-exe-identity\.mjs$/, /athena\?\./, 'Windows exe metadata (stock fallback)', 'keep', 'n/a', 'athena → branding.json'],
  [/set-exe-identity\.mjs$/, null, 'Windows exe company / copyright', 'replace', 'done', 'branding.organization / copyright'],
  [/electron\/main\.ts$/, /PRODUCT_IDENTITY\.copyright \?\?/, 'About copyright (stock fallback)', 'keep', 'n/a', 'athena → identity copyright'],
  [/electron\/main\.ts$/, /copyright:/, 'About panel copyright', 'replace', 'done', 'identity copyright from branding.json'],
  [/electron\/main\.ts$/, /setAppUserModelId/, 'Windows AUMID fallback', 'replace', 'done', 'PRODUCT_IDENTITY.appId'],
  [/scripts\/run-short-session-hang-repro\.mjs$/, null, 'dev script', 'keep', 'n/a'],
  [/electron\/bootstrap-runner\.ts$/, null, 'bootstrap installer source', 'keep', 'n/a', 'not reached with HERMES_DESKTOP_HERMES; bundled payload removes it (P09)'],
  [/electron\/updater\/system-proxy-env\.ts$/, null, 'host allowlist', 'keep', 'n/a'],
  [/src\/plugins\/radio\/plugin\.js$/, null, 'User-Agent identifier', 'keep', 'n/a'],
  [/billing\/dev-fixtures\.ts$/, null, 'dev fixture', 'keep', 'n/a'],
  [/i18n\/en_catalog\.ts$/, /Official Plugins/, 'attribution (official plugins)', 'keep', 'n/a', 'true credit for Nous-built plugins'],
  // ── docs / support links → supportUrl ──────────────────────────────────
  [/src\/lib\/docs\.ts$/, null, 'docs link', 'replace', 'done', 'athenaStrings.supportUrl'],
  [/sidebar\/section-states\.tsx$/, null, 'docs link', 'replace', 'done', 'athenaStrings.supportUrl'],
  [/src\/lib\/error-surface\.ts$/, /tls:|local:/, 'docs link', 'replace', 'done', 'athenaStrings.supportUrl'],
  [/src\/lib\/error-surface\.ts$/, /nous:/, 'Nous Portal link', 'hide', 'switch', 'only for a nous provider error'],
  [/components\/version-details\.tsx$/, null, 'source commit link', 'replace', 'done', 'athenaStrings.supportUrl'],
  [/onboarding\/index\.tsx$/, /bring-your-own-endpoint/, 'docs link', 'replace', 'done', 'athenaStrings.supportUrl'],
  [/electron\/update-stop-remedy\.ts$/, null, 'updater docs link', 'hide', 'unreachable', 'updateMechanism external'],
  [/components\/update-status\.tsx$/, null, 'release notes / installer link', 'hide', 'unreachable', 'updateMechanism external'],
  [/src\/lib\/update-notes\.ts$/, null, 'release notes source', 'hide', 'unreachable', 'updateMechanism external'],
  // ── Nous-hosted services: hide, never rename ───────────────────────────
  [/onboarding\/index\.tsx$/, null, 'Nous Portal sign-in row', 'hide', 'switch', 'isHiddenProvider (KeyFormStep) + sortProviders filter'],
  [/settings\/constants\.ts$/, null, 'Nous Portal key group', 'hide', 'switch', 'isHiddenProviderGroup'],
  [/src\/lib\/model-status-label\.ts$/, null, 'Nous Portal provider label', 'hide', 'switch', 'nous provider is filtered from every provider list'],
  [/electron\/portal-session\.ts$/, null, 'Nous Portal session', 'hide', 'unreachable', 'cloud connection mode only'],
  [/electron\/backend-health\.ts$/, null, 'Nous cloud status link', 'hide', 'unreachable', 'cloud backends only'],
  [/settings\/gateway-settings\.tsx$/, null, 'Nous cloud agents link', 'hide', 'unreachable', 'cloud connection mode only'],
  [/components\/boot-failure-overlay\.tsx$/, null, 'Nous cloud status link', 'hide', 'unreachable', 'cloud backend failure only'],
  [/billing\/use-billing-state\.ts$/, null, 'Nous billing link', 'hide', 'policy', 'Nous account billing'],
  [/shell\/terms-butterbar\.tsx$/, null, 'Nous terms link', 'hide', 'policy', 'Nous free tier only'],
  [/i18n\/.*\.ts$/, /install\.sh/, 'remote install hint', 'hide', 'p10', 'remote SSH gateways; points at the Nous installer'],
  [/i18n\/.*\.ts$/, /portal: /, 'Nous Portal support label', 'hide', 'p10', 'send-diagnostics dialog'],
  [/i18n\/.*\.ts$/, null, 'Nous service copy', 'hide', 'policy', 'Nous Portal / cloud / subscription surfaces, never shown without a Nous account'],
  [/components\/send-diagnostics-dialog\.tsx$/, null, 'support handoff links', 'hide', 'p10', 'also uploads to Nous storage: security follow-up'],
  [/electron\/remote-lifecycle\.ts$/, null, 'remote install hint', 'hide', 'p10', 'remote SSH gateways'],
  [/pet-generate\//, null, 'Nous Portal link', 'hide', 'p10', 'pet generation'],
  [/(electron\/hub-iframe-policy\.ts|hermes-bots\/skills-hub\.tsx)$/, null, 'Skills Hub origin', 'hide', 'p10', 'Bot Mode skills hub (Nous-hosted)'],
  [/src\/lib\/plugin-catalog\.ts$/, null, 'plugin catalog origin', 'hide', 'p10', 'Capabilities plugin catalog (Nous-hosted)'],
  [/catalog\/catalog-data\.ts$/, null, 'capabilities catalog docs', 'hide', 'p10', 'Capabilities catalog (Nous-hosted docs)'],
  [/src\/store\/shared-metrics\.ts$/, null, 'docs link', 'hide', 'p10', 'relay shared metrics']
]

function classify(file, text) {
  for (const [pathRe, textRe, kind, action, status, note = ''] of RULES) {
    if (pathRe.test(file) && (!textRe || textRe.test(text))) {
      return { kind, action, status, note }
    }
  }

  return null
}

function grep(treeish) {
  const args = ['grep', '-n', '-I', '-i', '-E', ...(treeish ? [] : ['--untracked']), '-e', PATTERN]
  if (treeish) args.push(treeish)
  args.push('--', 'apps/desktop', ...EXCLUDES)
  let raw = ''
  try {
    raw = execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    if (error.status !== 1) throw error
  }
  const re = new RegExp(PATTERN, 'gi')
  const rows = []
  for (const line of raw.split('\n').filter(Boolean)) {
    const rest = treeish ? line.slice(treeish.length + 1) : line
    const [, file, lineNo, text] = /^([^:]+):(\d+):(.*)$/.exec(rest)
    for (const match of text.matchAll(re)) rows.push({ file, line: Number(lineNo), match: match[0], text })
  }
  return rows
}

const key = row => `${row.file}\u0000${row.text.trim()}`
const base = grep(BASE)
const current = grep(null)
const baseKeys = new Set(base.map(key))
const currentKeys = new Set(current.map(key))
const problems = []

function decorate(row, where) {
  const c = classify(row.file, row.text)
  if (!c) problems.push(`unclassified (${where}): ${row.file}:${row.line}: ${row.text.trim()}`)
  return { ...row, ...(c ?? { kind: '?', action: '?', status: '?', note: '' }) }
}

const baseRows = base.map(row => {
  const decorated = decorate(row, 'base')
  const present = currentKeys.has(key(row))
  if (decorated.action === 'replace' && present) problems.push(`still present (replace): ${row.file}:${row.line}`)
  return { ...decorated, present }
})
const added = current.filter(row => !baseKeys.has(key(row))).map(row => decorate(row, 'branch'))
for (const row of [...baseRows.filter(r => r.present), ...added]) {
  if (STRICT.test(row.match) && !['keep', 'hide'].includes(row.action)) {
    problems.push(`current ${row.match} is ${row.action}: ${row.file}:${row.line}`)
  }
}

const cell = value => String(value).replace(/\|/g, '\\|')
const short = file => file.replace(/^apps\/desktop\//, '')
const tally = rows => {
  const counts = {}
  for (const row of rows) counts[`${row.action} / ${row.status}`] = (counts[`${row.action} / ${row.status}`] ?? 0) + 1
  return Object.entries(counts).sort().map(([k, n]) => `| ${k} | ${n} |`).join('\n')
}
const table = (rows, lineHeader) =>
  [`| File | ${lineHeader} | Mention | Kind | Action | Status | Note |`, '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${cell(short(r.file))} | ${r.line} | ${cell(r.match)} | ${cell(r.kind)} | ${r.action} | ${r.status} | ${cell(r.note)} |`)].join('\n')

const doc = `# Nous inventory (generated)

Every mention of Nous in \`apps/desktop\` matched by
\`${PATTERN.replace(/\\\\/g, '\\')}\` (case-insensitive; \`node_modules\`, \`dist\`,
\`release\`, \`build\` excluded), classified under D05's rules:

- **replace**: names the app's maker, publisher or ids, or is a docs / support
  link. Now reads \`branding.json\` / \`athenaStrings\` (status \`done\`).
- **hide**: a Nous-hosted service (Nous Portal, sign-in, credits, cloud). The
  text stays, never renamed; the surface is off: \`switch\` =
  \`athenaStrings.hideNousServices\`, \`policy\` = only with a Nous account or
  the Nous free tier (the Athena profile sets \`nous.guest: false\`),
  \`unreachable\` = a mode the Athena build never enters, \`p10\` = off the demo
  path and not patched yet (follow-up under P10).
- **keep**: MIT licence and copyright credits, code comments, identifiers,
  tests, developer docs, and stock-variant fallbacks of replaced values.

Generated by \`src/athena/scripts/nous-inventory.mjs\` against upstream
\`${BASE.slice(0, 10)}\`; do not edit by hand. Line numbers in the first table
are upstream's.

## Summary

| Action / status | Mentions |
|---|---|
${tally([...baseRows, ...added])}

## Upstream mentions (${baseRows.length})

${table(baseRows, 'Line (upstream)')}

## Mentions added on the Athena branch (${added.length})

${table(added, 'Line')}
`

if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = readFileSync(out, 'utf8')
  } catch {
    // reported below
  }
  if (committed !== doc) problems.push('nous-inventory.md is stale: run node src/athena/scripts/nous-inventory.mjs')
} else {
  writeFileSync(out, doc)
  console.log(`wrote ${path.relative(repo, out)}: ${baseRows.length} upstream + ${added.length} branch mentions`)
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
