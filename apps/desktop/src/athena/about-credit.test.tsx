// F14 slice 09: About credits Hermes Agent (fork sentence, upstream link, MIT licence) in the Athena build only.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { AboutSettings } from '@/app/settings/about-settings'
import type { DesktopUpdateStatus, DesktopVersionInfo } from '@/global'
import { en } from '@/i18n/en'
import { openPreview } from '@/store/preview'
import type * as UpdatesStore from '@/store/updates'

import { AthenaAboutCredit, FORK_LICENSE_TEXT, forkCreditSentence, UPSTREAM_URL } from './about-credit'
import { $clientConfig, type ClientConfigSnapshot } from './managed/client-config'

vi.mock('@/store/preview', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openPreview: vi.fn()
}))

// About's update cards talk to Electron; keep them idle (the same stubs as about-settings.test.tsx).
vi.mock('@/store/updates', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')
  const actual = await vi.importActual<typeof UpdatesStore>('@/store/updates')
  const idle = { applying: false, command: null, error: null, log: [], message: '', percent: null, stage: 'idle' }

  return {
    $backendUpdateApply: atom(idle),
    $backendUpdateChecking: atom(false),
    $backendUpdateStatus: atom<DesktopUpdateStatus | null>(null),
    $desktopVersion: atom<DesktopVersionInfo | null>(null),
    $updateApply: atom(idle),
    $updateChecking: atom(false),
    $updateStatus: atom<DesktopUpdateStatus | null>({ behind: 0, supported: true }),
    checkBackendUpdates: vi.fn(async () => null),
    checkUpdates: vi.fn(async () => null),
    openUpdateOverlayFor: vi.fn(),
    openUpdatesWindow: vi.fn(),
    refreshDesktopVersion: vi.fn(async () => null),
    setUpdateChannel: vi.fn(async () => null),
    sourceUpdateChannel: actual.sourceUpdateChannel,
    sourceUpdateTrack: actual.sourceUpdateTrack,
    startActiveUpdate: vi.fn()
  }
})

const LICENSE_FILE = path.resolve(import.meta.dirname, '../../../../LICENSE')

const snapshot = (overrides: Partial<ClientConfigSnapshot> = {}): ClientConfigSnapshot => ({
  config: { features: {} },
  configVersion: 118,
  devOverridesActive: false,
  error: null,
  role: 'researcher',
  source: 'server',
  variant: 'athena',
  verifiedAt: '2026-11-09T19:00:00Z',
  ...overrides
})

const SENTENCE =
  'Athena is made by SickKids. It is a fork of Hermes Agent by Nous Research, used under the MIT License.'

const openExternal = vi.fn(async () => {})

beforeEach(() => {
  openExternal.mockClear()
  vi.mocked(openPreview).mockClear()
  Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, openExternal } })
})

afterEach(() => {
  cleanup()
  $clientConfig.set(null)
})

describe('the Hermes Agent credit', () => {
  test('the sentence is built from branding.json', () => {
    expect(forkCreditSentence()).toBe(SENTENCE)
  })

  test('the licence shown is the fork LICENSE file, byte for byte', () => {
    expect(FORK_LICENSE_TEXT).toBe(readFileSync(LICENSE_FILE, 'utf8'))
    expect(FORK_LICENSE_TEXT).toMatch(/^MIT License$/m)
    expect(FORK_LICENSE_TEXT).toMatch(/^Copyright \(c\) 2025 Nous Research$/m)
  })

  test('the Athena build shows the sentence, the upstream link and the licence on request', () => {
    $clientConfig.set(snapshot())
    const { container } = render(<AthenaAboutCredit />)

    expect(screen.getByText(SENTENCE)).toBeTruthy()
    expect(screen.getByRole('link', { name: UPSTREAM_URL }).getAttribute('href')).toBe(
      'https://github.com/NousResearch/hermes-agent'
    )

    const toggle = screen.getByRole('button', { name: 'View licence' })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-athena-license]')).toBeNull()

    fireEvent.click(toggle)

    const shown = container.querySelector('[data-athena-license]')

    expect(screen.getByRole('button', { name: 'Hide licence' }).getAttribute('aria-expanded')).toBe('true')
    expect(shown?.textContent).toBe(readFileSync(LICENSE_FILE, 'utf8'))
    expect(shown?.id).toBe(toggle.getAttribute('aria-controls'))

    fireEvent.click(screen.getByRole('button', { name: 'Hide licence' }))
    expect(container.querySelector('[data-athena-license]')).toBeNull()
  })

  test('an older snapshot without a variant reads as Athena', () => {
    const { variant: _variant, ...older } = snapshot()

    $clientConfig.set(older)
    render(<AthenaAboutCredit />)

    expect(screen.getByText(SENTENCE)).toBeTruthy()
  })

  test('the upstream link opens in the system browser, not the in-app pane', async () => {
    $clientConfig.set(snapshot())
    render(<AthenaAboutCredit />)

    fireEvent.click(screen.getByRole('link', { name: UPSTREAM_URL }))
    await Promise.resolve()

    expect(openExternal).toHaveBeenCalledWith(UPSTREAM_URL)
    expect(openPreview).not.toHaveBeenCalled()
  })

  test('colours come from theme tokens, so light and dark both read', () => {
    $clientConfig.set(snapshot())
    const { container } = render(<AthenaAboutCredit />)
    fireEvent.click(screen.getByRole('button', { name: 'View licence' }))

    const credit = container.querySelector('[data-athena-about-credit]')!

    for (const node of [credit, ...credit.querySelectorAll('*')]) {
      expect(node.getAttribute('style')).toBeNull()
      expect(node.getAttribute('class') ?? '').not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|\b(?:white|black)\b/i)
    }
  })

  test.each([
    ['no client config (no Electron bridge)', null],
    ['the stock variant', snapshot({ variant: 'stock' })]
  ])('renders nothing with %s', (_label, snap) => {
    $clientConfig.set(snap)
    const { container } = render(<AthenaAboutCredit />)

    expect(container.innerHTML).toBe('')
  })
})

describe('Settings › About', () => {
  test('mounts the credit under the version hero in the Athena build', () => {
    $clientConfig.set(snapshot())
    const { container } = render(<AboutSettings />)

    const hero = screen.getByRole('heading', { name: en.updates.appName })
    const credit = container.querySelector('[data-athena-about-credit]')
    const managedLine = container.querySelector('[data-athena-managed-line]')

    expect(credit?.textContent).toContain(SENTENCE)
    // The version hero, then the credit, then the managed line.
    expect(hero.compareDocumentPosition(credit!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(credit!.compareDocumentPosition(managedLine!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test.each([
    ['without a client config', null],
    ['in the stock variant', snapshot({ variant: 'stock' })]
  ])('is unchanged %s', (_label, snap) => {
    $clientConfig.set(snap)
    const { container } = render(<AboutSettings />)

    expect(container.querySelector('[data-athena-about-credit]')).toBeNull()
    expect(screen.queryByText(/fork of Hermes Agent/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'View licence' })).toBeNull()
  })
})
