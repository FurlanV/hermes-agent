/**
 * F14: find every "Hermes" written directly in desktop source (not in the app's translation catalogs) and classify
 * it. Used by the inventory (`hermes-inventory.ts`) and by the residue tests.
 *
 * A row is one non-comment source line that mentions the bare word. Comments, tests, fixtures, the translation
 * catalogs (`src/i18n/`, listed separately) and the Athena folders are skipped. Each row gets:
 * - `kind` and `why`: what the text is;
 * - `action`: `replace`, `keep` or `flag` (F14 decision 3, `../hermes-names.ts`);
 * - `route`: how a `replace` row reaches Athena: `direct` (the line itself is wrapped in `brandText`),
 *   `error` (an error message, branded where the app shows errors) or `plugin` (a plugin's translations, branded
 *   by the plugin i18n pass).
 * - `done`: a `direct` row whose line already calls `brandText(`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { classifyMentions, type MentionAction } from '../hermes-names'

export type Surface = 'main' | 'renderer'
export type Route = '-' | 'direct' | 'error' | 'plugin'

export interface SourceRow {
  action: MentionAction
  done: boolean
  file: string
  kind: string
  line: number
  route: Route
  surface: Surface
  text: string
  why: string
}

type Rule = [file: RegExp, line: null | RegExp, kind: string, action: MentionAction | 'auto', route: Route, why: string]

/** First match wins. `auto` takes the action from the naming rules (replace, keep or flag). */
const RULES: Rule[] = [
  // ── not text a user reads ─────────────────────────────────────────────────
  [
    /./,
    /X-Hermes-|User-Agent|'Hermes-Desktop'|TERM_PROGRAM|user\.name=Hermes/,
    'identifier',
    'keep',
    '-',
    'protocol header, user agent or tool identity'
  ],
  [
    /^electron\/main\.ts$/,
    /HERMES_DESKTOP_APP_NAME \|\| 'Hermes'/,
    'stock fallback',
    'keep',
    '-',
    'the Athena identity sets the name first'
  ],
  [
    /./,
    /\b(console\.(log|warn|error|info|debug)|rememberLog|host\.log|options\.log|logger\.\w+)\(|^\s*log\(|^\s*[`'"]\[(updates|bootstrap|boot|backend|gateway|hermes)\]/,
    'developer log',
    'keep',
    '-',
    'written to a log file'
  ],
  [/^electron\/local-runtime-version\.ts$/, null, 'pattern', 'keep', '-', 'matches the engine banner'],
  [/^electron\/desktop-uninstall\.ts$/, /\.test\(dir\)/, 'pattern', 'keep', '-', 'matches an install folder name'],
  [/^src\/lib\/provider-setup-errors\.ts$/, null, 'pattern', 'keep', '-', 'matches backend error text'],
  [
    /^src\/app\/capabilities\/catalog\/catalog-detail\.tsx$/,
    /requiresHermes/,
    'engine version',
    'keep',
    '-',
    'the engine version a plugin needs'
  ],
  [
    /^src\/app\/settings\/constants\.ts$/,
    /Nous-trained/,
    'Nous service',
    'keep',
    '-',
    'the Nous provider group, hidden in Athena (isHiddenProviderGroup)'
  ],
  [
    /^src\/(lib\/browser-|store\/browser-tab-title\.ts$|app\/right-sidebar\/terminal\/terminal-session-attempt\.ts$|app\/session\/hooks\/use-prompt-actions\/browser-manage-refusal\.ts$)/,
    null,
    'Webapp only',
    'keep',
    '-',
    'shown only when the UI is served to a browser, not in the desktop app'
  ],
  // ── text a user reads ─────────────────────────────────────────────────────
  [
    /^src\/plugins\/[^/]+\/(i18n|[\w-]*-locales|group-surface-[\w-]+)\.ts$/,
    null,
    'plugin translations',
    'auto',
    'plugin',
    "a plugin's message bundle"
  ],
  [
    /./,
    /\b(throw\b|new \w*Error\(|reject\(|fail\(|refuse\(|invalidate\(|withTimeout\()|\berror: |errorMessage|ErrorMessage/,
    'error message',
    'auto',
    'error',
    'shown where the app reports an error'
  ],
  [/./, null, 'UI text', 'auto', 'direct', 'shown as written']
]

const SOURCE = /^(src|electron)\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/

const SKIP =
  /(\.(test|spec|stories)\.|\.d\.ts$|\/__snapshots__\/|\/test\/|test-utils|fixture|-repro\.|perf-probe|^src\/i18n\/|^src\/athena\/|^electron\/athena\/)/

/** Desktop source files (tracked and new), relative to `apps/desktop`. */
export function sourceFiles(desktop: string): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'electron'], {
    cwd: desktop,
    encoding: 'utf8'
  })

  return [...new Set(out.split('\n'))].filter(file => SOURCE.test(file) && !SKIP.test(file)).sort()
}

/** The line without its comments; `null` for a line that is only a comment. */
export function codeOf(line: string): null | string {
  if (/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line)) {
    return null
  }

  return line
    .replace(/\{?\/\*.*?\*\/\}?/g, '')
    .replace(/\s\/\/\s.*$/, '')
    .trimEnd()
}

function classify(file: string, code: string): Omit<SourceRow, 'done' | 'file' | 'line' | 'surface' | 'text'> {
  const named = classifyMentions(code) ?? 'replace'

  for (const [fileRe, lineRe, kind, action, route, why] of RULES) {
    if (fileRe.test(file) && (!lineRe || lineRe.test(code))) {
      if (action !== 'auto') {
        return { action, kind, route, why }
      }

      if (named === 'replace') {
        return { action: 'replace', kind, route, why }
      }

      return {
        action: named,
        kind,
        route: '-',
        why: named === 'flag' ? 'a pending name: the owner decides (F14 slice 07)' : 'names the engine (Hermes Agent)'
      }
    }
  }

  throw new Error(`unclassified: ${file}`)
}

/** The rows of one file's text (`file` relative to `apps/desktop`). */
export function scanText(file: string, content: string): SourceRow[] {
  const rows: SourceRow[] = []

  content.split('\n').forEach((raw, index) => {
    const code = codeOf(raw)

    if (code === null || !/\bHermes\b/.test(code)) {
      return
    }

    const row = classify(file, code)

    rows.push({
      ...row,
      done: row.route === 'direct' && code.includes('brandText('),
      file,
      line: index + 1,
      surface: file.startsWith('electron/') ? 'main' : 'renderer',
      text: code.trim()
    })
  })

  return rows
}

/** Every mention of "Hermes" written directly in desktop source. */
export function scanSources(desktop: string): SourceRow[] {
  return sourceFiles(desktop).flatMap(file => scanText(file, readFileSync(path.join(desktop, file), 'utf8')))
}
