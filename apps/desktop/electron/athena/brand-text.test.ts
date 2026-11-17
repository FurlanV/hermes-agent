// F14 slice 06: the main process names the product in the Athena build and leaves stock text alone.
import { afterEach, describe, expect, test, vi } from 'vitest'

import { brandText, mainBrandActive, setMainBrand } from './brand-text'

afterEach(() => {
  setMainBrand(null)
  vi.resetModules()
  vi.doUnmock('../install-stamp')
  vi.doUnmock('../product-identity')
})

describe('brandText (main)', () => {
  test('is off until startup switches it on', () => {
    expect(mainBrandActive()).toBe(false)
    expect(brandText('Quit Hermes')).toBe('Quit Hermes')
  })

  test('names the product once on, keeping the engine and commands', () => {
    setMainBrand('Athena')

    expect(brandText('Hermes is still working on 1 chat.')).toBe('Athena is still working on 1 chat.')
    expect(brandText('Show Hermes')).toBe('Show Athena')
    expect(brandText('Hermes Desktop SSH mode supports Linux')).toBe('Athena SSH mode supports Linux')
    expect(brandText('Hermes Agent not installed yet')).toBe('Hermes Agent not installed yet')
    expect(brandText('Run `hermes update` so Hermes restarts')).toBe('Run `hermes update` so Athena restarts')
  })
})

describe('brand-text-install', () => {
  const install = async (appId: string, stamp: unknown, displayName: string) => {
    vi.resetModules()
    vi.doMock('../install-stamp', () => ({ INSTALL_STAMP: stamp }))
    vi.doMock('../product-identity', () => ({ PRODUCT_IDENTITY: { appId, displayName } }))
    await import('./brand-text-install')

    return import('./brand-text')
  }

  test('the Athena identity switches the pass on with its display name', async () => {
    const brand = await install('ca.sickkids.athena', null, 'Athena')

    expect(brand.brandText('Quit Hermes')).toBe('Quit Athena')
  })

  test('an Athena install stamp switches it on too', async () => {
    const brand = await install('com.example.dev', { brand: 'athena' }, 'Athena')

    expect(brand.mainBrandActive()).toBe(true)
  })

  test('a stock build leaves it off', async () => {
    const brand = await install('com.nousresearch.hermes', null, 'Hermes')

    expect(brand.mainBrandActive()).toBe(false)
    expect(brand.brandText('Quit Hermes')).toBe('Quit Hermes')
  })
})
