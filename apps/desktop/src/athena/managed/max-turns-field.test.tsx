// F02 slice 24: Max agent steps (S70a, `agent.max_turns`) takes 10 to the role's `models.max_turns_limit`, shows the
// range and refuses anything else. Rendered through the upstream `ConfigField`, the way Settings › Advanced › Runtime
// renders it (the schema type is `string`: hermes's default is null).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ConfigField } from '@/app/settings/config-field'
import { I18nProvider } from '@/i18n'

import { $clientConfig, type ClientConfigSnapshot } from './client-config'
import { checkMaxTurns, maxTurnsLimit, maxTurnsRange, maxTurnsRangeText } from './max-turns-field'

const snapshot = (limit?: unknown, overrides: Partial<ClientConfigSnapshot> = {}): ClientConfigSnapshot => ({
  config: { models: limit === undefined ? { default: 'gpt-6-sol' } : { default: 'gpt-6-sol', max_turns_limit: limit } },
  configVersion: 118,
  devOverridesActive: false,
  error: null,
  role: 'researcher',
  source: 'server',
  verifiedAt: '2026-11-09T19:00:00Z',
  ...overrides
})

function field(value: unknown, schemaKey = 'agent.max_turns') {
  const onChange = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <ConfigField onChange={onChange} schema={{ type: 'string' }} schemaKey={schemaKey} value={value} />
    </I18nProvider>
  )

  return { onChange, view }
}

const input = () => screen.getByLabelText(/^max agent steps$/i) as HTMLInputElement

function type(text: string) {
  const el = input()
  act(() => el.focus())
  fireEvent.change(el, { target: { value: text } })
}

afterEach(() => {
  cleanup()
  $clientConfig.set(null)
})

describe('the range', () => {
  test('the ceiling is models.max_turns_limit, else 90', () => {
    expect(maxTurnsLimit(snapshot(40).config)).toBe(40)
    expect(maxTurnsLimit(snapshot().config)).toBe(90)
    expect(maxTurnsLimit(snapshot('lots').config)).toBe(90)
    expect(maxTurnsLimit(snapshot(0).config)).toBe(90)
    expect(maxTurnsLimit(undefined)).toBe(90)
    expect(maxTurnsRange(null)).toEqual({ max: 90, min: 10 })
    expect(maxTurnsRange(snapshot(5))).toEqual({ max: 5, min: 5 })
  })

  test.each([
    ['10', true],
    ['90', true],
    ['45', true],
    [' 45 ', true],
    ['9', false],
    ['91', false],
    ['0', false],
    ['-20', false],
    ['45.5', false],
    ['1e2', false],
    ['', false],
    ['unlimited', false]
  ])('%j within 10–90: %s', (draft, ok) => {
    expect(checkMaxTurns(draft, { max: 90, min: 10 }).ok).toBe(ok)
  })

  test('the copy names the range and who sets it', () => {
    expect(maxTurnsRangeText({ max: 90, min: 10 })).toBe('10 to 90 steps. SickKids sets the upper limit.')
    expect(maxTurnsRangeText({ max: 5, min: 5 })).toBe('Fixed at 5 by SickKids.')
  })
})

describe('the Settings field', () => {
  test('shows the range from the client config and the saved value', () => {
    $clientConfig.set(snapshot(40))
    field(25)

    expect(screen.getByText('10 to 40 steps. SickKids sets the upper limit.')).toBeTruthy()
    expect(input().value).toBe('25')
    expect(input().min).toBe('10')
    expect(input().max).toBe('40')
    expect(input().getAttribute('aria-describedby')).toBe(
      screen.getByText('10 to 40 steps. SickKids sets the upper limit.').id
    )
  })

  test('follows a new ceiling without a reload', () => {
    $clientConfig.set(snapshot(90))
    field(25)
    expect(screen.getByText('10 to 90 steps. SickKids sets the upper limit.')).toBeTruthy()
    act(() => $clientConfig.set(snapshot(40)))
    expect(screen.getByText('10 to 40 steps. SickKids sets the upper limit.')).toBeTruthy()
  })

  test('saves a value within the range when the field is left', () => {
    $clientConfig.set(snapshot(40))
    const { onChange } = field(25)

    type('35')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input())
    expect(onChange).toHaveBeenCalledExactlyOnceWith(35)
  })

  test('Enter saves too', () => {
    const { onChange } = field(25)

    type('10')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(10)
  })

  test.each(['9', '41', '0', '-5', '12.5', ''])('refuses %j: flagged while typed, never saved, put back', draft => {
    $clientConfig.set(snapshot(40))
    const { onChange } = field(25)

    type(draft)
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 10 to 40.')
    fireEvent.blur(input())
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('25')
    expect(screen.getByRole('alert').textContent).toBe('Not saved: Enter a whole number from 10 to 40.')

    // The next edit clears the note.
    type('30')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a value above the old ceiling is refused once the ceiling drops', () => {
    $clientConfig.set(snapshot(90))
    const { onChange } = field(25)

    act(() => $clientConfig.set(snapshot(40)))
    type('60')
    fireEvent.blur(input())
    expect(onChange).not.toHaveBeenCalled()
  })

  test('an unset or unlimited value shows blank with the ceiling as the hint', () => {
    for (const value of [null, 'unlimited', undefined]) {
      const { view } = field(value)
      expect(input().value).toBe('')
      expect(input().placeholder).toBe('90')
      view.unmount()
    }
  })

  test('a string value from the config reads as a number', () => {
    field('60')
    expect(input().value).toBe('60')
  })

  test('other keys keep the generic control', () => {
    const { view } = field(3, 'agent.api_max_retries')
    expect(view.container.querySelector('[data-athena-max-turns]')).toBeNull()
  })

  test('the stock variant keeps the generic control', () => {
    $clientConfig.set(snapshot(40, { variant: 'stock' }))
    const { view } = field(500)
    expect(view.container.querySelector('[data-athena-max-turns]')).toBeNull()
    expect(screen.queryByText(/SickKids sets the upper limit/)).toBeNull()
  })
})
