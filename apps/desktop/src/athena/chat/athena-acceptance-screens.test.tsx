/**
 * F15 slice 15: exports the acceptance transcript as static pages for the screenshots in `__screenshots__/`.
 * Skipped unless `ATHENA_F15_SCREENS` names a renderer build (`vite build --outDir <dir>`): each page is the thread
 * as jsdom rendered it (the theme's variables on <html>, the tokens on the thread root), linked to that build's
 * stylesheet (which carries chat.css), for `__screenshots__/shoot.mjs` to open in Chromium. No script runs in the
 * page: it is the rendered DOM, so the shots show the look, not behaviour (hover, focus, scrolling).
 *
 * Regenerate (from apps/desktop):
 *   pnpm exec vite build --outDir /tmp/f15-dist
 *   ATHENA_F15_SCREENS=/tmp/f15-dist pnpm exec vitest run --project ui src/athena/chat/athena-acceptance-screens.test.tsx
 *   node src/athena/chat/__screenshots__/shoot.mjs /tmp/f15-dist src/athena/chat/__screenshots__
 */
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { $activeSessionId, $busy, $turnStartedAt } from '@/store/session'

import { installFeaturePolicy } from '../managed/feature-policy'

import { renderAcceptanceTranscript } from './fixtures/acceptance-thread'
import { clearBuild, type LiveMoment, selectBuild } from './fixtures/acceptance-transcript'

const OUT = process.env.ATHENA_F15_SCREENS

stubThreadViewportSize()

/** The page's attributes, as markup. */
const attributes = (el: Element) =>
  [...el.attributes].map(attr => `${attr.name}="${attr.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)

const SHOTS: readonly { features: Record<string, string>; mode: 'dark' | 'light'; moment: LiveMoment; name: string }[] =
  [
    { name: 'athena-light-streaming', mode: 'light', moment: 'text', features: {} },
    { name: 'athena-dark-streaming', mode: 'dark', moment: 'text', features: {} },
    { name: 'athena-light-tool-running', mode: 'light', moment: 'tool', features: {} },
    { name: 'athena-dark-tool-running', mode: 'dark', moment: 'tool', features: {} },
    { name: 'upstream-light-row-off', mode: 'light', moment: 'text', features: { F15: 'off' } }
  ]

let uninstall = () => {}

afterEach(() => {
  cleanup()
  uninstall()
  clearBuild()
  $busy.set(false)
  $turnStartedAt.set(null)
  $activeSessionId.set(null)
})

describe.skipIf(!OUT)('the acceptance transcript as static pages', () => {
  test.each(SHOTS)('$name', async ({ features, mode, moment, name }) => {
    const css = readdirSync(path.join(OUT!, 'assets')).find(file => /^main-.*\.css$/.test(file))

    if (!css) {
      throw new Error(`no assets/main-*.css in ${OUT}: build the renderer there first`)
    }

    stubThreadEnvironment()
    uninstall = installFeaturePolicy()
    selectBuild('athena', features)
    $activeSessionId.set('session-f15-15-screens')
    $turnStartedAt.set(Date.now())
    $busy.set(true)

    const { theme } = await renderAcceptanceTranscript(moment)

    act(() => theme().setMode(mode))

    const html = window.document.documentElement
    const body = window.document.body

    writeFileSync(
      path.join(OUT!, `${name}.html`),
      `<!doctype html><html ${attributes(html).join(' ')}><head><meta charset="utf-8">` +
        `<link rel="stylesheet" href="assets/${css}"></head>` +
        `<body ${attributes(body).join(' ')}>${body.innerHTML}</body></html>`
    )
  })
})
