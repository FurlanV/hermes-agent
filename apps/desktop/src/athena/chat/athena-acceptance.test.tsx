/**
 * F15 slice 15: the plan's acceptance over one fixed transcript (`fixtures/acceptance-transcript.ts`: user text,
 * agent text, code, a table, a group of tools, a finished, a failed and a running tool, a system note, a streaming
 * reply and an error).
 *
 * - In the Athena layout, light and dark, each element is found by its own structure alone (slots, roles, labels,
 *   chip words, the token that paints it), never by its text, and no two kinds share a node.
 * - With row F15 off, and in a stock build (no snapshot, or a `stock` one), the thread is upstream's: no Athena
 *   component, slot, marker or token, and upstream's slots for every kind. Row off renders the no-snapshot tree
 *   (both under the build's default feature rows), and a stock snapshot the tree with no Athena policy at all.
 * - Every colour the Athena CSS paints with is a token the contrast checks (`chatContrastChecks`) hold to a ratio.
 *
 * jsdom has no layout and does not resolve `var()`: the stylesheet is injected and a declaration's value is read as
 * written, so "painted by token X" is what the cascade gives the element, and the root's values are checked apart.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, cleanup, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import { en } from '@/i18n/en'
import { clearAllPrompts } from '@/store/prompts'
import { $activeSessionId, $busy, $turnStartedAt } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'

import { installFeaturePolicy } from '../managed/feature-policy'
import { athenaStrings } from '../strings'
import { athenaTheme } from '../theme'

import { renderAcceptanceTranscript, type ThemeApi } from './fixtures/acceptance-thread'
import { clearBuild, type LiveMoment, selectBuild } from './fixtures/acceptance-transcript'
import { ATHENA_CHAT_ATTR } from './layout'
import {
  CHAT_STATES,
  chatContrastChecks,
  chatContrastFailures,
  type ChatTokenName,
  type ChatTokens,
  chatTokens
} from './tokens'

stubThreadViewportSize()

const SESSION = 'session-f15-15'
const CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'chat.css'), 'utf8')
const MOMENTS: readonly LiveMoment[] = ['tool', 'text']
const MODES = ['light', 'dark'] as const
const tools = athenaStrings.chat.tools

let sheet: HTMLStyleElement

// vitest loads no CSS: inject the Athena sheet (jsdom applies its declarations, unresolved).
beforeAll(() => {
  sheet = window.document.createElement('style')
  sheet.textContent = CSS
  window.document.head.append(sheet)
})

afterAll(() => sheet.remove())

/** The theme as the mounted thread last rendered it (to switch light and dark). */
let theme: () => ThemeApi

/** The transcript with its live turn at `moment`, mounted and settled; its thread root. */
async function renderTranscript(moment: LiveMoment) {
  const mounted = await renderAcceptanceTranscript(moment)

  theme = mounted.theme

  return mounted.root
}

let uninstall: () => void

beforeEach(() => {
  window.localStorage.clear()
  stubThreadEnvironment()
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  uninstall = installFeaturePolicy()
  clearAllPrompts()
  clearDismissedToolRows()
  $toolDisclosureStates.set({})
  __resetElapsedTimerRegistryForTests()
  // The live turn: the session is busy, its clock armed (the status line reads these).
  $activeSessionId.set(SESSION)
  $turnStartedAt.set(Date.now())
  $busy.set(true)
})

afterEach(() => {
  cleanup()
  uninstall()
  clearBuild()
  clearAllPrompts()
  $busy.set(false)
  $turnStartedAt.set(null)
  $activeSessionId.set(null)
  __resetElapsedTimerRegistryForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---- reading structure, never text ----

const all = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)]

/** The value the injected sheet gives `el` for `property`, as written (`var(--chat-…)`). */
const paint = (el: Element, property: string) => window.getComputedStyle(el).getPropertyValue(property).trim()

/** Every token name (from a real token set; any palette, only the names are read). */
const TOKEN_NAMES = Object.keys(chatTokens(athenaTheme.colors, false)) as ChatTokenName[]

/** The `--chat-*` tokens on the thread root, as a token set. */
const rootTokens = (root: HTMLElement) =>
  Object.fromEntries(TOKEN_NAMES.map(name => [name, root.style.getPropertyValue(`--${name}`)])) as ChatTokens

/** Split a selector list on its top-level commas (not those inside `:is()` or `:has()`). */
function selectorList(selectorText: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]

    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
    } else if (ch === ',' && depth === 0) {
      out.push(selectorText.slice(start, i).trim())
      start = i + 1
    }
  }

  return [...out, selectorText.slice(start).trim()]
}

/** The elements the sheet draws the streaming caret after (its rules that run the caret animation). */
function caretHosts(): Element[] {
  const selectors = [...sheet.sheet!.cssRules]
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .filter(rule => rule.style.getPropertyValue('animation').includes('--athena-caret-animation'))
    .flatMap(rule => selectorList(rule.selectorText))

  expect(selectors.length, 'chat.css has no caret rule').toBeGreaterThan(0)

  return [...new Set(selectors.flatMap(s => all(window.document, s.replace(/::after$/, ''))))]
}

/** The status rows as shown (an idle activity row stays mounted, hidden, for its live region). */
const SHOWN_STATUS = '[data-slot="aui_response-loading"], [data-slot="aui_turn-activity"][data-state="active"]'

/**
 * Each kind of element in the Athena layout, found by structure alone (no text query anywhere). The selectors are
 * the acceptance: if two kinds could only be told apart by what they say, there would be no selector to write.
 */
const ATHENA_KINDS = {
  user: '[data-slot="athena_user-message"][role="group"]',
  agent: '[data-slot="athena_assistant-message"][role="group"]',
  code: '[data-athena-code-block]',
  table: '[data-slot="aui_assistant-message-content"] .aui-md-table',
  toolGroup: '[data-athena-tool-group]',
  toolRow: '[data-athena-tool-row]',
  note: '[data-slot="athena_note"][data-athena-note]',
  status: SHOWN_STATUS,
  error: '[data-slot="aui_error-card"][role="alert"]'
} as const

const chip = (el: Element) => el.querySelector<HTMLElement>('[data-slot="athena_tool-chip"]')!

describe.each(MODES)('the acceptance transcript in the Athena layout, %s', mode => {
  beforeEach(() => selectBuild('athena'))

  test.each(MOMENTS)('live turn at %s: every element has its own structure', async moment => {
    const root = await renderTranscript(moment)

    act(() => theme().setMode(mode))

    // Painted in the mode asked for, on the Athena skin, with the tokens for it, every checked pair passing.
    expect(theme().themeName).toBe('athena')
    expect(theme().renderedMode).toBe(mode)
    expect(root.hasAttribute(ATHENA_CHAT_ATTR)).toBe(true)

    const colors = mode === 'dark' ? athenaTheme.darkColors! : athenaTheme.colors
    const tokens = rootTokens(root)

    expect(tokens).toEqual(chatTokens(colors, mode === 'dark'))
    expect(tokens['chat-agent-label']).toBe(colors.primary)
    expect(chatContrastFailures(tokens, colors)).toEqual([])

    // Every kind is there, found by its selector, and no node answers to two kinds.
    const found = Object.fromEntries(
      Object.entries(ATHENA_KINDS).map(([kind, selector]) => [kind, all(root, selector)])
    ) as Record<keyof typeof ATHENA_KINDS, HTMLElement[]>

    const owner = new Map<HTMLElement, string>()

    for (const [kind, elements] of Object.entries(found)) {
      if (kind === 'status' && moment === 'tool') {
        continue
      }

      expect(elements.length, kind).toBeGreaterThan(0)

      for (const el of elements) {
        expect(owner.get(el), `${kind} is also ${owner.get(el)}`).toBeUndefined()
        owner.set(el, kind)
      }
    }

    // User text: a group named "You", the visible label (hidden from the tree: the group says it), on the user
    // surface with its border; never a speaker label of the agent's.
    expect(found.user).toHaveLength(3)

    for (const user of found.user) {
      expect(user.getAttribute('aria-label')).toBe(athenaStrings.chat.userLabel)
      expect(user.querySelector('[data-slot="athena_user-label"]')?.getAttribute('aria-hidden')).toBe('true')
      expect(user.querySelector('[data-slot="athena_assistant-label"]')).toBeNull()

      // (jsdom drops a `var()` border shorthand, so the edge is the colour test's alone.)
      const bubble = user.querySelector('[data-slot="athena_user-bubble"]')!

      expect(paint(bubble, '--dt-user-bubble')).toBe('var(--chat-user-surface)')
      expect(paint(bubble.querySelector('.composer-human-message')!, 'background-color')).toBe(
        'var(--chat-user-surface)'
      )
    }

    // Agent text: a group named "Athena", labelled once per response in the agent label colour, no surface.
    for (const agent of found.agent) {
      expect(agent.getAttribute('aria-label')).toBe(athenaStrings.chat.agentLabel)
      expect(agent.querySelector('[data-slot="athena_user-label"]')).toBeNull()
      expect(paint(agent, 'background')).toBe('transparent')
    }

    const labels = all(root, '[data-slot="athena_assistant-label"]')

    expect(labels.length).toBeGreaterThan(0)

    for (const label of labels) {
      expect(label.closest(ATHENA_KINDS.agent)).not.toBeNull()
      expect(paint(label, 'color')).toBe('var(--chat-agent-label)')
    }

    // Code: its own surface, a header with the language and a named Copy, inside the agent's block.
    for (const code of found.code) {
      expect(code.closest(ATHENA_KINDS.agent)).not.toBeNull()
      expect(paint(code, 'background-color')).toBe('var(--chat-code-surface)')

      const header = code.querySelector<HTMLElement>(':scope > [data-slot="athena_code-header"]')!

      expect(header.querySelector('[data-slot="athena_code-language"]')).not.toBeNull()
      expect(within(header).getByRole('button', { name: en.assistant.tool.copyCode })).toBeTruthy()
    }

    // A table: upstream's table in the agent's text, its header row on the code surface.
    for (const table of found.table) {
      expect(table.closest(ATHENA_KINDS.code)).toBeNull()
      expect(paint(table.querySelector('thead')!, 'background-color')).toBe('var(--chat-code-surface)')
    }

    // Tool calls: one row each, a state chip that says its state in a word with its own icon and the state's
    // colours; the group's summary line counts its calls and carries the worst state.
    const chips = Object.fromEntries(CHAT_STATES.map(state => [state, [] as HTMLElement[]])) as Record<
      (typeof CHAT_STATES)[number],
      HTMLElement[]
    >

    for (const row of [...found.toolRow, ...found.toolGroup]) {
      const el = chip(row)
      const state = el.getAttribute('data-athena-tool-state') as (typeof CHAT_STATES)[number]

      expect(CHAT_STATES).toContain(state)
      expect(el.textContent).toBe(tools.state[state])
      expect(el.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
      expect(paint(el, 'color')).toBe('var(--athena-tool-state-text)')
      expect(paint(el, '--athena-tool-state-text')).toBe(`var(--chat-state-${state}-text)`)
      chips[state].push(row)
    }

    expect(chips.error.length, 'a failed tool').toBeGreaterThan(0)
    expect(chips.done.length, 'a finished tool').toBeGreaterThan(0)
    expect(chips.running.length, 'a running tool').toBe(moment === 'tool' ? 1 : 0)
    expect(new Set(CHAT_STATES.map(state => tools.state[state])).size).toBe(CHAT_STATES.length)

    for (const group of found.toolGroup) {
      const toggle = group.querySelector<HTMLElement>('[data-slot="athena_tool-group-toggle"]')!

      expect(toggle.tagName).toBe('BUTTON')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(group.querySelector('[data-slot="athena_tool-group-summary"]')).not.toBeNull()
      expect(group.querySelector('[data-slot="athena_tool-group-count"]')?.textContent).toBe(tools.calls(2))
    }

    for (const row of found.toolRow) {
      expect(row.querySelector('[data-slot="athena_tool-toggle"]')?.getAttribute('aria-expanded')).toBe('false')
    }

    // A system note: the note container with its kind, outside any speaker's group, no label.
    for (const note of found.note) {
      expect(note.getAttribute('data-athena-note')).toBe('background')
      expect(note.closest('[role="group"]')).toBeNull()
      expect(note.querySelector('[data-slot="athena_user-label"], [data-slot="athena_assistant-label"]')).toBeNull()
    }

    // The streaming reply: one status line with the working lead and one caret, at the end of the live text. While
    // a tool runs, its row narrates the wait instead (upstream's rule) and no text streams.
    const carets = caretHosts().filter(el => root.contains(el))

    if (moment === 'text') {
      expect(found.status).toHaveLength(1)
      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(found.status[0]!.querySelector('[data-slot="athena_status-lead"]')).not.toBeNull()
      expect(carets).toHaveLength(1)
      expect(carets[0]!.closest('.aui-md[data-status="running"]')).not.toBeNull()
    } else {
      expect(found.status).toHaveLength(0)
      expect(carets).toHaveLength(0)
    }

    // The error: one alert, a block on the error surface with the error edge, its own action.
    expect(found.error).toHaveLength(1)
    expect(screen.getAllByRole('alert')).toEqual(found.error)

    const error = found.error[0]!

    expect(paint(error, 'background')).toBe('var(--athena-error-surface)')
    expect(paint(error, '--athena-error-surface')).toBe('var(--chat-state-error-surface)')
    expect(paint(error, '--athena-error-edge')).toBe('var(--chat-state-error)')
    expect(error.dataset.severity).toBe('blocking')
    expect(within(error).getAllByRole('button').length).toBeGreaterThan(0)
  })
})

// ---- row off and stock builds: upstream's chat ----

const UPSTREAM_BUILDS = [
  ['the Athena variant with row F15 off', () => selectBuild('athena', { F15: 'off' })],
  ['a stock build (no snapshot)', () => selectBuild(null)],
  ["a stock build (a 'stock' snapshot)", () => selectBuild('stock')]
] as const

/** Upstream's slot for each kind (what its own thread tests query). */
const UPSTREAM_KINDS = {
  user: '[data-slot="aui_user-message-root"]',
  agent: '[data-slot="aui_assistant-message-root"]',
  system: '[data-slot="aui_system-message-root"]',
  tool: '[data-slot="tool-block"]',
  code: '[data-slot="code-card"]',
  table: '.aui-md-table',
  error: '[data-slot="aui_error-card"][role="alert"]'
} as const

/** Every Athena trace a node can carry: an Athena attribute or slot, or a chat token in its inline style. */
function athenaTraces(root: HTMLElement): string[] {
  return [root, ...all(root, '*')].flatMap(el =>
    [...el.attributes].flatMap(attr => {
      const trace =
        attr.name.startsWith('data-athena') ||
        (attr.name === 'data-slot' && attr.value.startsWith('athena_')) ||
        (attr.name === 'style' && attr.value.includes('--chat-'))

      return trace ? [`<${el.tagName.toLowerCase()} ${attr.name}="${attr.value.slice(0, 40)}">`] : []
    })
  )
}

/** The rendered tree as tags, slots and roles only (text, ids and timers left out). */
const skeleton = (el: Element): string =>
  `${el.tagName.toLowerCase()}${el.getAttribute('data-slot') ? `[${el.getAttribute('data-slot')}]` : ''}${
    el.getAttribute('role') ? `{${el.getAttribute('role')}}` : ''
  }(${[...el.children].map(skeleton).join(',')})`

describe.each(MOMENTS)('the acceptance transcript off the Athena layout, live turn at %s', moment => {
  test.each(UPSTREAM_BUILDS)("%s: it is upstream's chat", async (_name, build) => {
    build()
    const root = await renderTranscript(moment)

    expect(root.hasAttribute(ATHENA_CHAT_ATTR)).toBe(false)
    expect(root.getAttribute('style')).toBeNull()
    expect(athenaTraces(root)).toEqual([])
    expect(root.querySelector('[role="group"][aria-label]')).toBeNull()

    for (const [kind, selector] of Object.entries(UPSTREAM_KINDS)) {
      expect(root.querySelectorAll(selector).length, kind).toBeGreaterThan(0)
    }

    expect(root.querySelectorAll(UPSTREAM_KINDS.user)).toHaveLength(3)
    expect(
      root.querySelector('[data-slot="aui_user-message-root"] [data-slot="aui_user-bubble-actions"]')
    ).not.toBeNull()
  })

  test('row off renders the same tree as both stock builds', async () => {
    const tree = async (build: () => void) => {
      build()
      const out = skeleton(await renderTranscript(moment))

      cleanup()
      clearBuild()

      return out
    }

    // Row off is the no-snapshot tree: both run the build's default feature rows (F02), F15 aside.
    expect(await tree(() => selectBuild('athena', { F15: 'off' }))).toBe(await tree(() => selectBuild(null)))

    // A stock snapshot allows every row (F02), so it is the tree with no Athena policy at all: upstream's alone.
    const stock = await tree(() => selectBuild('stock'))

    uninstall()

    try {
      expect(stock).toBe(await tree(() => selectBuild(null)))
    } finally {
      uninstall = installFeaturePolicy()
    }
  })
})

// ---- every colour the Athena CSS paints with is checked ----

/** Each token stands for its own name, the page and the text for theirs, so a check names the tokens it holds. */
const sentinelTokens = () =>
  new Proxy({} as Record<string, string>, { get: (_, name) => String(name) }) as unknown as ChatTokens

const SENTINEL_COLORS = { background: 'page', foreground: 'text' }

/** The tokens a check holds to a ratio: as the ink (text, edge, ring) and as the surface under it. */
function checkedTokens() {
  const checks = chatContrastChecks(sentinelTokens(), SENTINEL_COLORS)

  return { inks: new Set(checks.map(check => check.ink)), surfaces: new Set(checks.map(check => check.on)) }
}

/**
 * Colours the Athena CSS uses that are not a `--chat-*` token pair, each with why it needs no chat check:
 * - `chat-code-border`: the hairline around a code block, under its header and a table's header, round a tool row
 *   and beside an open group. Decorative: what tells those apart is the surface, the header and the chip, so it is
 *   held to no ratio (WCAG 1.4.11 asks it of a boundary needed to identify a control; these are not that).
 * - `--dt-foreground`: the skin's own text colour, the `text` ink of the checks (on every Athena surface).
 * - `--ui-text-primary`, `--ui-text-secondary`: upstream's own text colours, where the layout keeps upstream's text
 *   (the group summary line, the "You" label); the skin's contrast, not the chat tokens'.
 */
const DECORATIVE_TOKENS = new Set<string>(['chat-code-border'])
const SKIN_COLORS = new Set(['--dt-foreground', '--ui-text-primary', '--ui-text-secondary'])

/** Properties whose value is a colour that is painted (text, fill, edge, ring). */
const COLOUR_PROPERTY =
  /^(?:color|background(?:-color|-image)?|border(?:-[a-z-]+)?|outline(?:-color)?|fill|stroke|box-shadow|text-decoration(?:-color)?|caret-color|column-rule(?:-color)?)$/

/** Every `property: value` declaration in chat.css (comments dropped; a selector never ends in `;` or `}`). */
function declarations(css: string): { property: string; value: string }[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')

  return [...body.matchAll(/(?<![\w-])((?:--)?[a-zA-Z][\w-]*)\s*:\s*([^;{}]*?)\s*(?:!important\s*)?(?=[;}])/g)].map(
    match => ({
      property: match[1]!,
      value: match[2]!
    })
  )
}

const varRefs = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]!)

/** What the Athena CSS paints with: per role (text colour, anything else), the custom properties it reaches. */
function paintedColours(css: string) {
  const decls = declarations(css)
  const defined = new Map<string, string[]>()

  for (const { property, value } of decls.filter(d => d.property.startsWith('--'))) {
    defined.set(property, [...(defined.get(property) ?? []), ...varRefs(value)])
  }

  // A custom property chat.css defines is followed to what it is set from; any other is a colour from outside.
  const resolveVar = (name: string, seen = new Set<string>()): string[] => {
    if (!defined.has(name) || seen.has(name)) {
      return [name]
    }

    seen.add(name)

    return defined.get(name)!.flatMap(ref => resolveVar(ref, seen))
  }

  const consumed = new Set(decls.flatMap(d => varRefs(d.value)))
  const text = new Set<string>()
  const other = new Set<string>()

  for (const { property, value } of decls) {
    const painted = COLOUR_PROPERTY.test(property)
    // A custom property set here but read only by upstream's CSS (`--dt-user-bubble`, `--err-*`, …) carries a colour
    // out of chat.css: count what it is set from as painted.
    const forwarded = property.startsWith('--') && !consumed.has(property)

    if (!painted && !forwarded) {
      continue
    }

    for (const source of varRefs(value).flatMap(ref => resolveVar(ref))) {
      ;(property === 'color' ? text : other).add(source)
    }
  }

  return { other, text }
}

describe('the colours the Athena CSS paints with', () => {
  const painted = paintedColours(CSS)
  const { inks, surfaces } = checkedTokens()
  const used = new Set([...painted.text, ...painted.other])
  const tokenOf = (name: string) => (name.startsWith('--chat-') ? name.slice(2) : null)

  test('the CSS is read through its own custom properties (the state and error colours are found)', () => {
    for (const state of CHAT_STATES) {
      for (const name of [`chat-state-${state}`, `chat-state-${state}-surface`, `chat-state-${state}-text`]) {
        expect(used, name).toContain(`--${name}`)
      }
    }

    expect(used).toContain('--chat-user-surface')
    expect(painted.text).toContain('--chat-note-text')
  })

  test('every chat token it paints is held to a ratio by the contrast checks, or is decorative', () => {
    const unchecked = [...used].flatMap(name => {
      const token = tokenOf(name)

      return token && !DECORATIVE_TOKENS.has(token) && !inks.has(token) && !surfaces.has(token) ? [token] : []
    })

    expect(unchecked).toEqual([])

    // A text colour is checked as the ink, not only as a surface.
    const textNotInk = [...painted.text].flatMap(name => {
      const token = tokenOf(name)

      return token && !inks.has(token) ? [token] : []
    })

    expect(textNotInk).toEqual([])
  })

  test('every other colour is a skin colour listed above', () => {
    expect([...used].filter(name => !tokenOf(name) && !SKIN_COLORS.has(name))).toEqual([])
  })

  test('the allow-lists are not stale', () => {
    for (const token of DECORATIVE_TOKENS) {
      expect(used, token).toContain(`--${token}`)
      expect(inks.has(token) || surfaces.has(token), `${token} is checked; drop it from the list`).toBe(false)
    }

    for (const name of SKIN_COLORS) {
      expect(used, name).toContain(name)
    }
  })

  test('the checks name only real tokens', () => {
    for (const name of [...inks, ...surfaces].filter(n => n !== 'page' && n !== 'text')) {
      expect(TOKEN_NAMES, name).toContain(name)
    }
  })
})
