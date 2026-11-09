import { afterEach, describe, expect, test } from 'vitest'

import type { OverlayNavGroup } from '@/app/overlays/overlay-split-layout'

import { $featureFilter, ALLOW_ALL_FEATURES, allowedEntries, isFeatureAllowed, setFeatureFilter } from './features'
import {
  allowedSettingsSubpages,
  filterSettingsNav,
  isConfigFieldAllowed,
  isSettingsLocationAllowed,
  isSettingsTabAllowed
} from './settings-entries'

const Icon = () => null

const link = (id: string, children?: { id: string }[]): OverlayNavGroup => ({
  active: false,
  icon: Icon,
  id,
  label: id,
  onSelect: () => {},
  ...(children ? { children: children.map(child => link(child.id)) } : {})
})

afterEach(() => setFeatureFilter(null))

describe('feature filter', () => {
  test('allows everything by default', () => {
    expect($featureFilter.get()).toBe(ALLOW_ALL_FEATURES)
    expect(isFeatureAllowed('settings:billing')).toBe(true)
  })

  test('allowedEntries keeps array identity when nothing is removed', () => {
    const rows = [{ id: 'a' }, { id: 'b' }]

    expect(allowedEntries(rows, () => true)).toBe(rows)
    expect(allowedEntries(rows, row => row.id === 'a')).toEqual([{ id: 'a' }])
  })
})

describe('Settings entry ids', () => {
  test('a denied page denies its children, sub-views and fields', () => {
    setFeatureFilter(id => id !== 'settings:providers' && id !== 'settings:config:model')

    expect(isSettingsTabAllowed('providers&pview=keys')).toBe(false)
    expect(isSettingsTabAllowed('gateway')).toBe(true)
    expect(isConfigFieldAllowed('model', 'model_context_length')).toBe(false)
    expect(isConfigFieldAllowed('chat', 'timezone')).toBe(true)
    expect(allowedSettingsSubpages('config:model', [{ id: 'main' }])).toEqual([])
  })

  test('locations resolve page=, pview=, kview= and bview= to the same child id', () => {
    setFeatureFilter(id => !['settings:about/updates', 'settings:keys/tools', 'settings:billing/plans'].includes(id))

    expect(isSettingsLocationAllowed(new URLSearchParams('tab=about&page=updates'))).toBe(false)
    expect(isSettingsLocationAllowed(new URLSearchParams('tab=about&page=uninstall'))).toBe(true)
    expect(isSettingsLocationAllowed(new URLSearchParams('tab=keys&kview=tools'))).toBe(false)
    expect(isSettingsLocationAllowed(new URLSearchParams('tab=billing&bview=plans'))).toBe(false)
    expect(isSettingsLocationAllowed(new URLSearchParams('tab=billing'))).toBe(true)
    expect(isSettingsLocationAllowed(new URLSearchParams(''))).toBe(true)
  })

  test('the nav drops refused groups and children, and returns the same groups when nothing is refused', () => {
    const groups = [
      link('billing', [{ id: 'bview:overview' }, { id: 'bview:plans' }]),
      link('about', [{ id: 'about:updates' }, { id: 'about:uninstall' }]),
      link('web-access')
    ]

    expect(filterSettingsNav(groups)).toBe(groups)

    setFeatureFilter(id => id !== 'settings:billing/plans' && id !== 'settings:web-access')

    expect(filterSettingsNav(groups).map(group => [group.id, group.children?.map(child => child.id) ?? []])).toEqual([
      ['billing', ['bview:overview']],
      ['about', ['about:updates', 'about:uninstall']]
    ])
  })
})
