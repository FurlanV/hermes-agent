// @vitest-environment node
// The Athena branding contract: branding.json drives the `athena` identity
// variant (ca.sickkids.athena, "Athena", no feed) and its install stamp
// (updater owned externally). Identity and stamp are evaluated in fresh Node
// processes so no variant leaks between cases.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { BUILTIN_THEMES, DEFAULT_SKIN_NAME } from '@/themes/presets'

import branding from './branding.json'
import { athenaTheme } from './theme'

const desktop = path.resolve(import.meta.dirname, '../..')

function node(args: string[], variant: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HERMES_DESKTOP_VARIANT: variant }

  for (const key of [
    'HERMES_PAYLOAD_TAG',
    'HERMES_BUILD_COMMIT',
    'HERMES_PAYLOAD_VERSION',
    '_HERMES_CHANNEL_REQUEST_JSON'
  ]) {
    delete env[key]
  }

  return execFileSync(process.execPath, args, { cwd: desktop, encoding: 'utf8', env }).trim()
}

function identity(variant: string): Record<string, unknown> {
  return JSON.parse(
    node(
      ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(desktop, 'product-identity.cjs')],
      variant
    )
  )
}

function stamp(variant: string, platform: string): Record<string, unknown> {
  const script = `
    const { buildStampPayload } = await import(${JSON.stringify(path.join(desktop, 'scripts/write-build-stamp.mjs'))})
    const base = { commit: 'a'.repeat(40), branch: 'athena/desktop', dirty: false, source: 'local' }
    console.log(JSON.stringify(buildStampPayload(base, process.env, ${JSON.stringify(platform)})))`

  return JSON.parse(node(['--input-type=module', '-e', script], variant))
}

describe('branding.json', () => {
  test('has the fields the build and the renderer read', () => {
    for (const key of [
      'display',
      'kebab',
      'pascal',
      'artifactPascal',
      'appIdPrefix',
      'organization',
      'organizationLegal',
      'msixPublisher',
      'msixPublisherDisplayName',
      'tagline',
      'supportUrl',
      'logo',
      'logoSha256',
      'fontStack'
    ] as const) {
      expect(typeof branding[key], key).toBe('string')
      expect(branding[key].length, key).toBeGreaterThan(0)
    }

    expect(branding.kebab).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(branding.pascal).toMatch(/^[A-Z][A-Za-z0-9]*$/)
    expect(branding.artifactPascal).not.toBe(branding.pascal)
    expect(branding.msixPublisher).toMatch(/^CN=/)
    expect(branding.supportUrl).toMatch(/^https:\/\//)

    for (const mode of ['light', 'dark'] as const) {
      for (const value of Object.values(branding.colors[mode])) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })
})

describe('icon sources', () => {
  test('the logo copy is byte-identical to the pinned athena/shared/logo file', () => {
    const logo = readFileSync(path.join(import.meta.dirname, branding.logo))

    expect(createHash('sha256').update(logo).digest('hex')).toBe(branding.logoSha256)
  })
})

describe('athena identity variant', () => {
  test('is SickKids Athena with no release feed', () => {
    const athena = identity('athena')

    expect(athena).toMatchObject({
      appId: 'ca.sickkids.athena',
      displayName: 'Athena',
      appNamePascal: 'Athena',
      channel: null,
      light: false,
      store: false,
      msixAppIdWithOrg: 'SickKids.Athena'
    })
    // cliName stays `hermes`: it is the payload CLI command, not a product name.
    const { cliName, ...names } = athena
    expect(cliName).toBe('hermes')
    expect(JSON.stringify(names)).not.toMatch(/nousresearch|Hermes/i)
  })

  test('leaves the stock identity alone', () => {
    expect(identity('')).toMatchObject({ appId: 'com.nousresearch.hermes', displayName: 'Hermes', channel: 'latest' })
  })

  test('stamps an externally owned bootstrap build on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(stamp('athena', platform)).toMatchObject({
        payload: 'bootstrap',
        updateMechanism: 'external',
        brand: 'athena'
      })
    }

    expect(stamp('', 'darwin')).not.toHaveProperty('brand')
  })
})

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)

  const [r, g, b] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map(channel => {
    const c = channel / 255

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi + 0.05) / (lo + 0.05)
}

describe('athena theme', () => {
  test('is the default built-in skin', () => {
    expect(DEFAULT_SKIN_NAME).toBe('athena')
    expect(BUILTIN_THEMES[DEFAULT_SKIN_NAME]).toBe(athenaTheme)
  })

  test('fetches no web font (an empty fontUrl masks the Nous skin underneath)', () => {
    expect(athenaTheme.typography?.fontUrl).toBe('')
    expect(athenaTheme.typography?.fontSans).toContain(branding.fontStack)
  })

  test('paints the branding seeds', () => {
    expect(athenaTheme.colors).toMatchObject({
      background: branding.colors.light.background,
      primary: branding.colors.light.accent
    })
    expect(athenaTheme.darkColors).toMatchObject({
      background: branding.colors.dark.background,
      primary: branding.colors.dark.accent
    })
  })

  test.each([
    ['light', athenaTheme.colors],
    ['dark', athenaTheme.darkColors!]
  ])('%s text pairs pass WCAG AA (4.5:1)', (_mode, colors) => {
    for (const [ink, surface] of [
      [colors.foreground, colors.background],
      [colors.mutedForeground, colors.background],
      [colors.mutedForeground, colors.muted],
      [colors.primaryForeground, colors.primary],
      [colors.primary, colors.background],
      [colors.foreground, colors.userBubble!],
      [colors.destructiveForeground, colors.destructive]
    ]) {
      expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
