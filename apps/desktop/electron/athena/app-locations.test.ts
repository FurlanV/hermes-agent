import { describe, expect, test } from 'vitest'

import { appPathEntries, deepLinkEntries, settingsLocationEntries } from './app-locations'
import { deepLinkPolicy } from './main-policy'

describe('the entries a location reaches', () => {
  test.each([
    ['/settings?tab=billing', ['settings:billing']],
    ['/settings?tab=providers&pview=local', ['settings:providers', 'settings:providers/local']],
    ['#/settings?tab=config:model&page=moa', ['settings:config:model', 'settings:config:model/moa']],
    ['/settings?tab=keys&key=SUDO_PASSWORD', ['settings:keys', 'credential:SUDO_PASSWORD']],
    ['/settings', []],
    ['/cron', ['route:/cron']],
    ['/messaging/telegram', ['route:/messaging']],
    ['/command-center?section=usage', ['route:/command-center', 'command-center:usage']],
    ['/', ['route:/']]
  ])('%s', (path, entries) => {
    expect(appPathEntries(path)).toEqual(entries)
  })

  test('deep links: open/<path> is the app path; other kinds are deep-link:<kind>', () => {
    expect(deepLinkEntries({ kind: 'open', name: 'settings', params: { tab: 'billing' } })).toEqual(['settings:billing'])
    expect(deepLinkEntries({ kind: 'mcp', name: 'install', params: {} })).toEqual(['deep-link:mcp', 'deep-link:mcp/install'])
    expect(settingsLocationEntries(new URLSearchParams('tab=config:advanced&field=toolsets'))).toEqual([
      'settings:config:advanced',
      'config-field:toolsets'
    ])
  })

  test('main refuses hermes://open/settings?tab=billing and a disabled tab with the build defaults', () => {
    const allowed = deepLinkPolicy({})

    expect(allowed({ kind: 'open', name: 'settings', params: { tab: 'billing' } })).toBe(false)
    expect(allowed({ kind: 'open', name: 'settings', params: { tab: 'vault' } })).toBe(false)
    expect(allowed({ kind: 'open', name: 'settings', params: { tab: 'keybinds' } })).toBe(true)
    expect(deepLinkPolicy({ features: { S53: 'on' } })({ kind: 'open', name: 'settings', params: { tab: 'vault' } })).toBe(
      true
    )
  })
})
