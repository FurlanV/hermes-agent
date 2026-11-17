/**
 * F14: the renderer's brand pass. In the Athena build, text a user reads names Athena instead of Hermes, under the
 * naming rules in `hermes-names.ts`. In a stock build (and wherever no Athena client-config snapshot exists, such
 * as tests without the Electron bridge) every function here returns its input unchanged.
 *
 * - `brandCatalog` maps a whole translation catalog; `resolveTranslations` (`src/i18n/registry.ts`) calls it, so
 *   React's `t`, `translateNow` and backend language packs all pass through it.
 * - `brandText` is for one string written directly in upstream code: the line is wrapped, the text stays upstream's.
 */
import { KEEP_KEYS, renameHermes } from './hermes-names'
import { athenaStrings } from './strings'

let override: boolean | null = null

/** True in the Athena build: the preload's client-config snapshot says `variant: 'athena'`. */
export function athenaBrandActive(): boolean {
  if (override !== null) {
    return override
  }

  if (typeof window === 'undefined') {
    return false
  }

  const snapshot = (window as { athenaDesktop?: { clientConfig?: { snapshot?: unknown } } }).athenaDesktop?.clientConfig
    ?.snapshot

  return Boolean(snapshot && typeof snapshot === 'object' && (snapshot as { variant?: unknown }).variant === 'athena')
}

/** Test seam: force the pass on or off; `null` reads the bridge again. */
export function setAthenaBrandForTests(active: boolean | null): void {
  override = active
}

/** `text` as the Athena build shows it. */
export function brandText(text: string, locale = 'en'): string {
  return athenaBrandActive() ? renameHermes(text, athenaStrings.product, locale) : text
}

type Message = (...args: unknown[]) => unknown

/** A function message whose output is renamed; its own arguments (user names, paths) are never touched. */
function brandMessage(message: Message, locale: string): Message {
  const branded = (...args: unknown[]): unknown => {
    const out = message(...args)

    return typeof out === 'string'
      ? renameHermes(
          out,
          athenaStrings.product,
          locale,
          args.filter((arg): arg is string => typeof arg === 'string')
        )
      : out
  }

  Object.defineProperty(branded, 'length', { value: message.length })

  return branded
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

function mapTree(value: unknown, key: string, locale: string): unknown {
  if (key && KEEP_KEYS[key]) {
    return value
  }

  if (typeof value === 'string') {
    return renameHermes(value, athenaStrings.product, locale)
  }

  if (typeof value === 'function') {
    return brandMessage(value as Message, locale)
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => mapTree(item, key ? `${key}.${index}` : String(index), locale))
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([child, next]) => [child, mapTree(next, key ? `${key}.${child}` : child, locale)])
    )
  }

  return value
}

/** A message tree (an app catalog or a plugin bundle) as the Athena build shows it; the input itself is untouched. */
export function brandCatalog<T>(catalog: T, locale: string): T {
  return athenaBrandActive() ? (mapTree(catalog, '', locale) as T) : catalog
}
