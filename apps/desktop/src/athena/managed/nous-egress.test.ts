// @vitest-environment node
// F02 slice 18, the app half of the startup egress check (the backend half is athena's
// tests/hook_sequence/test_egress.py, which runs the gateway daemon headless with a socket audit hook). The GUI cannot
// be launched here, so this is a static inventory: every Electron main and renderer source that names a Nous host
// (nousresearch.com and subdomains, the github.io docs mirror) is classified, and each one that can *fetch* is behind
// an entry the Athena variant refuses (or, for the stock Capabilities catalog, behind managed.tools). A new Nous
// host in upstream code fails this test until it is classified here.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { ipcEntries, restEntries, rpcEntries } from '../../../electron/athena/backend-policy'
import { BUNDLED_DEFAULT_CONFIG } from '../../../electron/athena/bundled-config-data'
import { featureEntryFilter } from '../../../electron/athena/feature-registry'
import { backendDecider } from '../../../electron/athena/tool-install-policy'

const desktop = path.resolve(import.meta.dirname, '../../..')
const NOUS_HOST = /nousresearch\.com|nousresearch\.github\.io/

type Use =
  | { gate: string; kind: 'fetch'; why: string }
  | { kind: 'fetch-other'; why: string }
  | { gate?: string; kind: 'link'; why: string }

/** Every source naming a Nous host: shown as a link (opened only by a click) or fetched, and what keeps it shut. */
const INVENTORY: Record<string, Use> = {
  'electron/backend-health.ts': { kind: 'link', why: 'recognises *.agents.nousresearch.com cloud backends; no request' },
  'electron/hub-iframe-policy.ts': { gate: 'plugin:hermes-bots', kind: 'fetch', why: "Bot Mode's skills hub iframe" },
  'electron/portal-session.ts': { gate: 'ipc:hermes:cloud:login', kind: 'fetch', why: 'Hermes Cloud portal login (S84)' },
  'electron/remote-lifecycle.ts': { kind: 'link', why: 'an install hint printed for a remote SSH backend' },
  'electron/update-stop-remedy.ts': { kind: 'link', why: 'the updating guide, shown when an in-app update stops' },
  'electron/updater/system-proxy-env.ts': {
    gate: 'ipc:hermes:updates:apply',
    kind: 'fetch',
    why: 'the in-app updater (S69); the Athena variant has no feed (updateMechanism external)'
  },
  'src/app/capabilities/catalog/catalog-data.ts': {
    kind: 'fetch-other',
    why: 'the stock Capabilities catalog; the Athena catalog page replaces it while managed.tools is enforce or report (slice 28)'
  },
  'src/app/pet-generate/components/generate-unavailable.tsx': { gate: 'palette:appearance-generate-pet', kind: 'fetch', why: 'S38' },
  'src/app/settings/billing/dev-fixtures.ts': { gate: 'settings:billing', kind: 'fetch', why: 'Billing page (S77)' },
  'src/app/settings/billing/use-billing-state.ts': { gate: 'rpc:billing.state', kind: 'fetch', why: 'billing.state (S77)' },
  'src/app/settings/constants.ts': { kind: 'link', why: 'the Nous Portal provider docs link (hidden by D05)' },
  'src/app/settings/gateway-settings.tsx': { gate: 'settings-control:gateway-mode-cloud', kind: 'fetch', why: 'S84' },
  'src/app/shell/terms-butterbar.tsx': { gate: 'dialog:portal-terms', kind: 'link', why: 'free-tier terms bar (S110)' },
  'src/components/boot-failure-overlay.tsx': { kind: 'link', why: 'a portal status link on a cloud boot failure' },
  'src/components/onboarding/index.tsx': { gate: 'dialog:onboarding', kind: 'fetch', why: 'stock onboarding (S109)' },
  'src/components/send-diagnostics-dialog.tsx': { gate: 'rpc:diagnostics.share_nous', kind: 'fetch', why: 'S117' },
  'src/components/update-status.tsx': { kind: 'link', why: 'the installer page link' },
  'src/lib/error-surface.ts': { kind: 'link', why: 'provider console links on error cards' },
  'src/lib/plugin-catalog.ts': {
    gate: 'rpc:plugins.catalog.lookup',
    kind: 'fetch',
    why: 'the plugin catalog lookup and its feed fallback, refused (with the lookup itself) under managed.tools (slice 29)'
  },
  'src/plugins/hermes-bots/skills-hub.tsx': { gate: 'plugin:hermes-bots', kind: 'fetch', why: 'Bot Mode (S123, off)' },
  'src/store/shared-metrics.ts': { gate: 'rpc:shared_metrics.status', kind: 'fetch', why: 'usage stats to Nous (S49)' }
}

function sources(dir: string): string[] {
  return readdirSync(path.join(desktop, dir)).flatMap(name => {
    const rel = path.join(dir, name)

    if (statSync(path.join(desktop, rel)).isDirectory()) {
      return ['node_modules', 'i18n', 'athena', '__tests__', 'fixtures'].includes(name) ? [] : sources(rel)
    }

    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec|stories)\.|\.d\.ts$|test-utils?\./.test(name) ? [rel] : []
  })
}

/** Whether the Athena variant (bundled default config) refuses an inventory gate. */
function refused(gate: string): boolean {
  const filter = featureEntryFilter(BUNDLED_DEFAULT_CONFIG)
  const decide = backendDecider(BUNDLED_DEFAULT_CONFIG)

  if (gate.startsWith('rpc:')) {
    return !decide(rpcEntries(gate.slice(4)), 'rpc', gate).allowed
  }

  if (gate.startsWith('ipc:')) {
    return !decide(ipcEntries(gate.slice(4)), 'ipc', gate).allowed
  }

  if (gate.startsWith('rest:')) {
    return !decide(restEntries({ method: 'GET', pathname: gate.slice(5) }), 'rest', gate).allowed
  }

  return !filter(gate)
}

describe('Nous hosts in the app (Athena variant)', () => {
  const found = [...sources('electron'), ...sources('src')].filter(file =>
    NOUS_HOST.test(readFileSync(path.join(desktop, file), 'utf8'))
  )

  test('every source naming a Nous host is classified', () => {
    expect(found.filter(file => !(file in INVENTORY))).toEqual([])
  })

  test.each(Object.entries(INVENTORY).filter(([, use]) => use.kind !== 'link' || 'gate' in use))(
    '%s is shut in the Athena variant',
    (_file, use) => {
      if ('gate' in use && use.gate) {
        expect(refused(use.gate), use.gate).toBe(true)
      }
    }
  )
})
