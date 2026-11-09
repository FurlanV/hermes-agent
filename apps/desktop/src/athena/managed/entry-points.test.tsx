import { readFileSync } from 'node:fs'
import path from 'node:path'

// F02 slice 16: entry points outside Settings follow the same flags. A table
// over every registry row with such entries (shortcut, page, deep link, palette
// row, status item, sidebar row, slash command, error-card button, plugin,
// pane, dialog): off → inert, on → works. Then the real surfaces that carry
// them: palette rows, slash replies, toasts, OS and in-app deep links, Bot
// Mode and the terminal pane.
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  actRender,
  Harness,
  type HarnessHandle,
  RUNTIME_SESSION_ID
} from '@/app/session/hooks/use-prompt-actions/index-test-utils'
import { clearSingleFlightSessionResumeState } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { $pluginRecords, pluginActive, publishPlugin } from '@/contrib/plugins-store'
import { pathFromHermesDeepLink, resolveHermesOpenPath } from '@/lib/hermes-open-target'
import { $notifications, clearNotifications, notify, RECOVERY_ACTIONS } from '@/store/notifications'
import { $connection } from '@/store/session'
import { dropSessionState } from '@/store/session-states'

import { FEATURE_ROWS, featureEntryFilter, type FeatureRow, rowsForEntry } from '../../../electron/athena/feature-registry'
import { applyMainPolicies } from '../../../electron/athena/main-policy'
import { deepLinkAllowed, setMainPolicySeams } from '../../../electron/athena/policy-seams'

import { applyPluginPolicy, sidebarRowsToHide } from './entry-point-guards'
import {
  allowedPaletteGroups,
  allowedStatusbarItems,
  appRouteVerdict,
  isAppPathAllowed,
  isErrorActionAllowed,
  isKeybindAllowed,
  isSlashCommandAllowed,
  SLASH_NOT_AVAILABLE
} from './entry-points'
import { type FeatureFilter, setFeatureFilter } from './features'

const pane = vi.hoisted(() => ({ visible: false }))

vi.mock('@/components/pane-shell/tree/store', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPaneVisible: (id: string) => id === 'terminal' && pane.visible,
  togglePaneVisible: (id: string) => {
    if (id === 'terminal') {
      pane.visible = !pane.visible
    }
  }
}))

vi.mock('@/hermes', () => ({
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: 'session' })),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getHermesConfig: vi.fn(async () => ({ display: { timestamps: false } })),
  getHermesConfigDefaults: vi.fn(async () => ({})),
  getSession: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  setApiRequestProfile: vi.fn(),
  transcribeAudio: vi.fn()
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

const all = (flag: 'off' | 'on') => Object.fromEntries(FEATURE_ROWS.map(r => [r.id, flag]))
const onlyOff = (row: FeatureRow) => featureEntryFilter({ features: { ...all('on'), [row.id]: 'off' } })
const onlyOn = (row: FeatureRow) => featureEntryFilter({ features: { ...all('off'), [row.id]: 'on' } })
const exclusive = (row: FeatureRow, entry: string) => rowsForEntry(entry)?.every(id => id === row.id) ?? false

/** Whether the surface that carries `entry` lets it through under `filter`. */
function reachable(entry: string, filter: FeatureFilter): boolean {
  const [kind, ...rest] = entry.split(':')
  const id = rest.join(':')

  switch (kind) {
    case 'keybind':
      return isKeybindAllowed(id, filter)

    case 'route':
      return isAppPathAllowed(id, filter) && appRouteVerdict(id, '', filter) === 'ok'

    case 'command-center':
      return isAppPathAllowed(`/command-center?section=${id}`, filter)

    case 'palette':
      return allowedPaletteGroups([{ items: [{ id }] }], filter).length === 1

    case 'statusbar':
      return allowedStatusbarItems([{ id }], filter).length === 1

    case 'nav':
      return !sidebarRowsToHide(filter).includes(id)

    case 'slash':
      return isSlashCommandAllowed([id], filter)

    case 'error-action':
      return isErrorActionAllowed(id, filter)

    default:
      return filter(entry)
  }
}

const OUTSIDE = /^(keybind|route|command-center|palette|statusbar|nav|slash|error-action|deep-link|plugin|pane|dialog):/
const ROWS = FEATURE_ROWS.filter(row => row.entries.some(entry => OUTSIDE.test(entry)))

afterEach(() => {
  cleanup()
  setFeatureFilter(null)
  setMainPolicySeams(null)
  clearNotifications()
})

describe('every entry point outside Settings', () => {
  test('the rows the plan names have entries here', () => {
    const ids = ROWS.map(row => row.id)

    for (const id of ['S78', 'S111', 'S112', 'S113', 'S114', 'S116', 'S117', 'S118a', 'S118b', 'S119', 'S122', 'S123', 'S124']) {
      expect(ids).toContain(id)
    }
  })

  test.each(ROWS.map(row => [row.id, row.mark, row] as const))('%s (%s): off → inert; on → works', (_id, mark, row) => {
    const entries = row.entries.filter(entry => OUTSIDE.test(entry))

    for (const entry of entries.filter(e => exclusive(row, e))) {
      expect(reachable(entry, onlyOff(row)), `${entry} with ${row.id} off`).toBe(false)
    }

    for (const entry of entries) {
      expect(reachable(entry, onlyOn(row)), `${entry} with only ${row.id} on`).toBe(mark !== 'remove' || !exclusive(row, entry))
    }
  })

  test('keep rows work with the build defaults', () => {
    const defaults = featureEntryFilter({})

    for (const row of ROWS.filter(r => r.mark === 'keep')) {
      for (const entry of row.entries.filter(e => OUTSIDE.test(e))) {
        expect(reachable(entry, defaults), `${row.id} ${entry}`).toBe(true)
      }
    }

    expect(isSlashCommandAllowed(['reasoning'], defaults)).toBe(true)
    expect(isKeybindAllowed('nav.settings', defaults)).toBe(true)
  })
})

describe('deep links', () => {
  const link = (name: string, params: Record<string, string> = {}) => ({ kind: 'open', name, params })

  test('main drops hermes://open/settings?tab=billing and a link to a disabled tab, and opens allowed ones', () => {
    applyMainPolicies({ config: {} })

    expect(deepLinkAllowed(link('settings', { tab: 'billing' }))).toBe(false)
    expect(deepLinkAllowed(link('settings', { tab: 'config:voice' }))).toBe(false)
    expect(deepLinkAllowed(link('settings', { tab: 'providers', pview: 'local' }))).toBe(false)
    expect(deepLinkAllowed(link('settings', { tab: 'config:advanced', field: 'toolsets' }))).toBe(false)
    expect(deepLinkAllowed(link('cron'))).toBe(false)
    expect(deepLinkAllowed(link('settings', { tab: 'about' }))).toBe(true)
    expect(deepLinkAllowed(link('settings', { tab: 'config:advanced', field: 'agent.max_turns' }))).toBe(true)
    expect(deepLinkAllowed(link('index-network/intent/1'))).toBe(true)

    applyMainPolicies({ config: { features: { S82: 'on', S113: 'on' } } })
    expect(deepLinkAllowed(link('settings', { tab: 'providers', pview: 'local' }))).toBe(true)
    expect(deepLinkAllowed(link('cron'))).toBe(true)
    expect(deepLinkAllowed(link('settings', { tab: 'billing' }))).toBe(false)
  })

  test('in-app open targets (toasts, plugin activate, delivered deep links) resolve a refused path to nothing', () => {
    setFeatureFilter(featureEntryFilter({}))

    expect(resolveHermesOpenPath('hermes://open/settings?tab=billing')).toBeNull()
    expect(pathFromHermesDeepLink('open', 'settings', { tab: 'web-access' })).toBeNull()
    expect(pathFromHermesDeepLink('open', 'cron')).toBeNull()
    expect(resolveHermesOpenPath('/command-center?section=usage')).toBeNull()
    expect(resolveHermesOpenPath('hermes://open/settings?tab=about')).toBe('/settings?tab=about')

    setFeatureFilter(featureEntryFilter({ features: { S113: 'on' } }))
    expect(pathFromHermesDeepLink('open', 'cron')).toBe('/cron')
  })
})

describe('toasts', () => {
  test('a recovery button into a refused page is left off; with the page on it stays', () => {
    setFeatureFilter(featureEntryFilter({}))
    notify({ id: 'k', message: 'Rejected key', action: RECOVERY_ACTIONS.openKeys('OPENAI_API_KEY') })
    notify({ id: 'u', message: 'Update', action: RECOVERY_ACTIONS.openUpdates() })
    notify({ id: 'm', message: 'Disk', action: RECOVERY_ACTIONS.openMaintenance() })
    const byId = (id: string) => $notifications.get().find(n => n.id === id)

    expect(byId('k')?.action).toBeUndefined()
    expect(byId('u')?.action).toBeUndefined()
    expect(byId('m')?.action?.label).toBeTruthy()

    setFeatureFilter(featureEntryFilter({ features: { S95: 'on' } }))
    notify({ id: 'k2', message: 'Rejected key', action: RECOVERY_ACTIONS.openKeys('OPENAI_API_KEY') })
    expect(byId('k2')?.action?.label).toBeTruthy()
  })
})

describe('slash commands', () => {
  const requestGateway = () => vi.fn(async (method: string) => (method === 'slash.exec' ? { output: 'ok' } : {}) as never)

  async function mount(gateway: ReturnType<typeof requestGateway>): Promise<HarnessHandle> {
    let handle: HarnessHandle | null = null
    await actRender(
      <Harness onReady={h => (handle = h)} refreshSessions={async () => undefined} requestGateway={gateway} />
    )

    return handle!
  }

  const text = (handle: HarnessHandle) =>
    handle
      .state()
      .messages.flatMap(message => message.parts.map(part => ('text' in part ? String(part.text) : '')))
      .join('\n')

  beforeEach(() => {
    clearSingleFlightSessionResumeState()
    $connection.set({ mode: 'local', wsUrl: 'ws://localhost/api/ws?native_dial=unminted' } as never)
  })

  afterEach(() => {
    $connection.set(null)
    dropSessionState(RUNTIME_SESSION_ID)
    vi.restoreAllMocks()
  })

  test.each(['/yolo', '/approvals manual', '/subscription', '/tools', '/debug'])(
    '%s replies "Not available in Athena" and never reaches the backend',
    async command => {
      setFeatureFilter(featureEntryFilter({}))
      const gateway = requestGateway()
      const handle = await mount(gateway)

      await handle.submitText(command)

      expect(gateway.mock.calls.filter(([method]) => method === 'slash.exec')).toEqual([])
      expect(text(handle)).toContain(SLASH_NOT_AVAILABLE)
    }
  )

  test('with S118a on, /approvals runs on the backend again', async () => {
    setFeatureFilter(featureEntryFilter({ features: { S118a: 'on' } }))
    const gateway = requestGateway()
    const handle = await mount(gateway)

    await handle.submitText('/approvals manual')

    expect(text(handle)).not.toContain(SLASH_NOT_AVAILABLE)
  })
})

describe('Bot Mode (S123)', () => {
  test('off: the bundled plugin stays listed but does not activate; on (dev override): it does', async () => {
    const handle = { activate: vi.fn(), deactivate: vi.fn() }
    publishPlugin({ id: 'hermes-bots', kind: 'bundled', name: 'Bot Mode', status: 'loaded' }, handle)

    setFeatureFilter(featureEntryFilter({}))
    expect(pluginActive('hermes-bots')).toBe(false)
    applyPluginPolicy('hermes-bots', false)
    expect(handle.deactivate).toHaveBeenCalledOnce()
    expect($pluginRecords.get()['hermes-bots']?.status).toBe('disabled')

    // A dev override turning S123 on reaches the renderer as a new config.
    setFeatureFilter(featureEntryFilter({ features: { S123: 'on' } }))
    expect(pluginActive('hermes-bots')).toBe(true)
    applyPluginPolicy('hermes-bots', true)
    expect(handle.activate).toHaveBeenCalledOnce()
  })
})

describe('the terminal pane (S124)', () => {
  test('off: no pane, shortcut, status item or palette toggle; on: the toggle opens it', async () => {
    const { toggleTerminalPane } = await import('@/app/right-sidebar/terminal/reveal-focus')
    pane.visible = false

    const off = featureEntryFilter({})
    setFeatureFilter(off)
    toggleTerminalPane()
    expect(pane.visible).toBe(false)
    expect(isKeybindAllowed('view.showTerminal', off)).toBe(false)
    expect(isKeybindAllowed('view.newTerminal', off)).toBe(false)
    expect(allowedStatusbarItems([{ actionId: 'view.showTerminal', id: 'terminal' }], off)).toEqual([])
    expect(allowedPaletteGroups([{ items: [{ action: 'view.showTerminal', id: 'view.showTerminal' }] }], off)).toEqual([])

    setFeatureFilter(featureEntryFilter({ features: { S124: 'on' } }))
    toggleTerminalPane()
    expect(pane.visible).toBe(true)
  })
})

// Rebase tripwire: every upstream hook still asks the policy at its choke point.
describe('the upstream hooks are in place', () => {
  const src = (file: string) => readFileSync(path.join(import.meta.dirname, '../..', file), 'utf8')

  test.each([
    ['app/hooks/use-keybinds.ts', /if \(!handler \|\| !isKeybindAllowed\(actionId\)\) \{\n\s+return false/],
    ['app/hooks/use-keybinds.ts', /if \(!handler \|\| !isKeybindAllowed\(actionId\)\) \{\n\s+return\n/],
    ['app/settings/keybind-settings.tsx', /allKeybindActions\(contributions\)\.filter\(action => isKeybindAllowed/],
    ['lib/hermes-open-target.ts', /return allowedOpenPath\(resolveOpenPath\(target\)\)/],
    ['app/shell/hooks/use-overlay-routing.ts', /useAppRouteGuard\(location\.pathname, location\.search, goHome\)/],
    ['app/shell/hooks/use-statusbar-items.tsx', /allowedStatusbarItems\(\[\.\.\.coreLeftStatusbarItems/],
    ['app/shell/hooks/use-statusbar-items.tsx', /allowedStatusbarItems\(\[\.\.\.extraRightItems/],
    ['app/command-palette/index.tsx', /allowedPaletteGroups\(\[\.\.\.baseGroups, \.\.\.searchGroups, \.\.\.branchGroup\]/],
    ['app/session/hooks/use-prompt-actions/slash.ts', /if \(!isSlashCommandAllowed\(\[name, resolvedCommand\?\.name\]\)\)/],
    ['lib/desktop-slash-commands.ts', /if \(!isSlashCommandAllowed\(\[normalized, canonicalDesktopSlashCommand/],
    ['components/assistant-ui/thread/assistant-message.tsx', /useFeatureEntry\(`error-action:\$\{action\}`\)/],
    ['store/notifications.ts', /action: allowedNotificationAction\(input\.action\)/],
    ['app/command-center/index.tsx', /SECTIONS\.filter\(value => featureFilter\(`command-center:\$\{value\}`\)\)/],
    ['contrib/plugins-store.ts', /if \(!isFeatureAllowed\(`plugin:\$\{id\}`\)\) \{\n\s+return false/],
    ['app/right-sidebar/terminal/reveal-focus.ts', /if \(revealed && !isFeatureAllowed\('pane:terminal'\)\)/],
    ['store/profile.ts', /isFeatureAllowed\('dialog:create-profile'\)/],
    ['store/profile-share.ts', /isFeatureAllowed\('dialog:create-profile'\)/],
    ['app/profiles/create-profile-dialog.tsx', /open=\{open && athenaAllowed\}/],
    ['store/send-diagnostics.ts', /isFeatureAllowed\('dialog:send-diagnostics'\)/]
  ])('%s', (file, pattern) => {
    expect(src(file)).toMatch(pattern)
  })
})
