/**
 * F15: the chat colour tokens (plan: Design › Colour tokens). Built from a skin's background, foreground and accent
 * (`primary`, the accent seed; `colors.accent` is the soft tint) with the skin's own `mix`, so under the Athena skin
 * they come from the branding seeds and under any other skin they are derived the same way from that skin. The
 * values are fixed against the contrast checks below (`branding.test.ts` runs them on the Athena skin):
 *
 * | Token | Light | Dark | Check |
 * |---|---|---|---|
 * | `chat-user-surface` | accent 10% on background | accent 18% | foreground on it ≥ 4.5 |
 * | `chat-user-border` | accent 65% | accent 60% | ≥ 3 against the page |
 * | `chat-agent-label` | accent (`#005ba8`) | accent (`#00b3e2`) | ≥ 4.5 against the page |
 * | `chat-code-surface` / `-border` | foreground 4% / 12% | foreground 8% / 16% | foreground on it ≥ 4.5 |
 * | `chat-note-text` | foreground 70% on background (the skin's `mutedForeground`) | same | ≥ 4.5 against the page |
 * | `chat-note-rule` | foreground 50% | foreground 40% | ≥ 3 against the page |
 * | `chat-state-<s>` | one hue per state, both modes | same | chip edge ≥ 3 against the page |
 * | `chat-state-<s>-surface` | hue 12% on background | hue 20% | chip fill |
 * | `chat-state-<s>-text` | foreground 30% into the hue | same | ≥ 4.5 on the chip fill |
 *
 * The plan's starting point for the user border (accent 25% / 35%) gives about 1.5:1 / 2:1 against the page, so it
 * was raised to the least that passes. The note rule (slice 06) is held to the same 3:1, at the least amount (in 5%
 * steps) that passes. A state hue is the same in light and dark and clears 3:1 on both Athena pages (4.5:1 on both
 * is not possible for one colour, so chip text is per mode).
 */
import { contrastRatio, parseColor, toHex } from '@hermes/shared/color'

import type { DesktopThemeColors } from '@/themes/types'

import { mix } from '../theme'

export const CHAT_STATES = ['running', 'done', 'error'] as const
export type ChatState = (typeof CHAT_STATES)[number]

/** One hue per state (blue, green, red), the same in light and dark; picked to clear 3:1 on both Athena pages. */
export const CHAT_STATE_HUES: Readonly<Record<ChatState, string>> = Object.freeze({
  running: '#2f80ed',
  done: '#1f8f4e',
  error: '#e5484d'
})

type StateTokenName = `chat-state-${ChatState}` | `chat-state-${ChatState}-surface` | `chat-state-${ChatState}-text`

export type ChatTokenName =
  | 'chat-agent-label'
  | 'chat-code-border'
  | 'chat-code-surface'
  | 'chat-note-rule'
  | 'chat-note-text'
  | 'chat-user-border'
  | 'chat-user-surface'
  | StateTokenName

export type ChatTokens = Readonly<Record<ChatTokenName, string>>

/** The amounts per appearance: light first, dark second. */
const AMOUNT = {
  userSurface: [0.1, 0.18],
  userBorder: [0.65, 0.6],
  codeSurface: [0.04, 0.08],
  codeBorder: [0.12, 0.16],
  noteText: [0.7, 0.7],
  noteRule: [0.5, 0.4],
  stateSurface: [0.12, 0.2],
  stateText: [0.3, 0.3]
} as const

/** A skin colour as `#rrggbb` (`mix` reads only that form); an unparseable one falls back. */
const hex = (color: string, fallback: string) => {
  const rgb = parseColor(color)

  return rgb ? toHex(rgb) : fallback
}

/** The chat tokens for one skin palette; `dark` is the appearance actually painted. */
export function chatTokens(
  colors: Pick<DesktopThemeColors, 'background' | 'foreground' | 'primary'>,
  dark: boolean
): ChatTokens {
  const background = hex(colors.background, dark ? '#000000' : '#ffffff')
  const foreground = hex(colors.foreground, dark ? '#ffffff' : '#000000')
  const accent = hex(colors.primary, foreground)
  const at = (amounts: readonly [number, number]) => amounts[dark ? 1 : 0]

  const states = Object.fromEntries(
    CHAT_STATES.flatMap(state => {
      const hue = CHAT_STATE_HUES[state]

      return [
        [`chat-state-${state}`, hue],
        [`chat-state-${state}-surface`, mix(hue, background, at(AMOUNT.stateSurface))],
        [`chat-state-${state}-text`, mix(foreground, hue, at(AMOUNT.stateText))]
      ]
    })
  ) as Record<StateTokenName, string>

  return Object.freeze({
    'chat-user-surface': mix(accent, background, at(AMOUNT.userSurface)),
    'chat-user-border': mix(accent, background, at(AMOUNT.userBorder)),
    'chat-agent-label': accent,
    'chat-code-surface': mix(foreground, background, at(AMOUNT.codeSurface)),
    'chat-code-border': mix(foreground, background, at(AMOUNT.codeBorder)),
    'chat-note-text': mix(foreground, background, at(AMOUNT.noteText)),
    'chat-note-rule': mix(foreground, background, at(AMOUNT.noteRule)),
    ...states
  })
}

export interface ChatContrastCheck {
  ink: string
  min: number
  name: string
  on: string
}

/** Every pair of the plan's Check column, for one palette and its tokens. */
export function chatContrastChecks(tokens: ChatTokens, colors: Pick<DesktopThemeColors, 'background' | 'foreground'>) {
  const page = colors.background
  const text = colors.foreground

  const checks: ChatContrastCheck[] = [
    { name: 'text on chat-user-surface', ink: text, on: tokens['chat-user-surface'], min: 4.5 },
    { name: 'chat-user-border against the page', ink: tokens['chat-user-border'], on: page, min: 3 },
    { name: 'chat-agent-label against the page', ink: tokens['chat-agent-label'], on: page, min: 4.5 },
    { name: 'code text on chat-code-surface', ink: text, on: tokens['chat-code-surface'], min: 4.5 },
    { name: 'chat-note-text against the page', ink: tokens['chat-note-text'], on: page, min: 4.5 },
    { name: 'chat-note-rule against the page', ink: tokens['chat-note-rule'], on: page, min: 3 }
  ]

  for (const state of CHAT_STATES) {
    checks.push(
      {
        name: `chat-state-${state}-text on its chip`,
        ink: tokens[`chat-state-${state}-text`],
        on: tokens[`chat-state-${state}-surface`],
        min: 4.5
      },
      { name: `chat-state-${state} chip edge against the page`, ink: tokens[`chat-state-${state}`], on: page, min: 3 }
    )
  }

  return checks
}

/** The checks that fail, as readable lines; empty when every pair passes. */
export function chatContrastFailures(
  tokens: ChatTokens,
  colors: Pick<DesktopThemeColors, 'background' | 'foreground'>
): string[] {
  return chatContrastChecks(tokens, colors).flatMap(({ ink, min, name, on }) => {
    const ratio = contrastRatio(ink, on) ?? 0

    return ratio >= min ? [] : [`${name}: ${ink} on ${on} is ${ratio.toFixed(2)}:1, needs ${min}:1`]
  })
}

/** The tokens as CSS custom properties (`--chat-user-surface`, …), for an inline style. */
export function chatTokenVars(tokens: ChatTokens): Record<`--${ChatTokenName}`, string> {
  return Object.fromEntries(Object.entries(tokens).map(([name, value]) => [`--${name}`, value])) as Record<
    `--${ChatTokenName}`,
    string
  >
}
