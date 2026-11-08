// @vitest-environment node
// The Athena branding contract: branding.json drives the `athena` identity
// variant (ca.sickkids.athena, "Athena", no feed) and its install stamp
// (updater owned externally). Identity and stamp are evaluated in fresh Node
// processes so no variant leaks between cases.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import branding from './branding.json'

const desktop = path.resolve(import.meta.dirname, '../..')

function node(args: string[], variant: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HERMES_DESKTOP_VARIANT: variant }

  for (const key of ['HERMES_PAYLOAD_TAG', 'HERMES_BUILD_COMMIT', 'HERMES_PAYLOAD_VERSION', '_HERMES_CHANNEL_REQUEST_JSON']) {
    delete env[key]
  }

  return execFileSync(process.execPath, args, { cwd: desktop, encoding: 'utf8', env }).trim()
}

function identity(variant: string): Record<string, unknown> {
  return JSON.parse(
    node(['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(desktop, 'product-identity.cjs')], variant)
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
    for (const key of ['display', 'kebab', 'pascal', 'artifactPascal', 'appIdPrefix', 'organization', 'organizationLegal',
      'msixPublisher', 'msixPublisherDisplayName', 'tagline', 'supportUrl', 'logo', 'fontStack'] as const) {
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
      expect(stamp('athena', platform)).toMatchObject({ payload: 'bootstrap', updateMechanism: 'external', brand: 'athena' })
    }

    expect(stamp('', 'darwin')).not.toHaveProperty('brand')
  })
})
