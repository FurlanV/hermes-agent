import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { ATHENA_APP_ID, desktopVariant } from './variant'

describe('desktop variant', () => {
  test('the Athena app id matches branding.json', () => {
    const branding = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../src/athena/branding.json'), 'utf8')
    ) as { appIdPrefix: string; kebab: string }

    expect(ATHENA_APP_ID).toBe(`${branding.appIdPrefix}.${branding.kebab}`)
  })

  test('the stamp brand or the baked app id say Athena; anything else is stock', () => {
    expect(desktopVariant({ brand: 'athena' }, 'com.nousresearch.hermes')).toBe('athena')
    expect(desktopVariant(null, ATHENA_APP_ID)).toBe('athena')
    expect(desktopVariant({ updateMechanism: 'self' }, 'com.nousresearch.hermes')).toBe('stock')
    expect(desktopVariant(undefined, undefined)).toBe('stock')
  })
})
