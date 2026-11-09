// Athena: the feature entry ids an in-app location reaches (F02 slice 16).
//
// Pure, no imports, shared by Electron main (OS deep links) and the renderer
// (in-app open targets, the app route guard, status-bar and toast links), so
// `hermes://open/settings?tab=billing`, a toast's "Open keys" and a typed
// `#/cron` are judged by the same entries as the Settings nav.

/** Settings pages whose children are picked by their own param rather than `page=`. */
export const SUB_VIEW_PARAMS: Readonly<Record<string, string>> = { billing: 'bview', keys: 'kview', providers: 'pview' }

/** The sub-view each of those pages shows when its param is absent (settings/index.tsx defaults). */
export const SUB_VIEW_DEFAULTS: Readonly<Record<string, string>> = {
  billing: 'overview',
  keys: 'tools',
  providers: 'accounts'
}

/** Deep-link params that name one row on a Settings page, and the entry id each one is. */
const ROW_PARAMS: readonly (readonly [param: string, prefix: string])[] = [
  ['field', 'config-field:'],
  ['setting', 'setting:'],
  ['key', 'credential:']
]

/**
 * Every entry a Settings location must be allowed for: the page, the child it
 * names (`page=` or the page's sub-view param) and any row it names. A
 * location with no `tab` is the Settings home (no entries).
 */
export function settingsLocationEntries(params: URLSearchParams): string[] {
  const view = params.get('tab')

  if (!view) {
    return []
  }

  const subViewParam = SUB_VIEW_PARAMS[view]
  const page = params.get('page') ?? (subViewParam ? params.get(subViewParam) : null)
  const entries = [`settings:${view}`]

  if (page) {
    entries.push(`settings:${view}/${page}`)
  }

  for (const [param, prefix] of ROW_PARAMS) {
    const value = params.get(param)

    if (value) {
      entries.push(`${prefix}${value}`)
    }
  }

  return entries
}

/**
 * The entries an app path (`/cron`, `/settings?tab=billing`,
 * `/command-center?section=usage`) reaches. Other paths reach `route:<path>`
 * (first segment), which no row lists unless the audit names it.
 */
export function appPathEntries(path: string): string[] {
  const raw = path.startsWith('#') ? path.slice(1) : path
  const query = raw.indexOf('?')
  const pathname = (query === -1 ? raw : raw.slice(0, query)).replace(/\/+$/, '') || '/'
  const params = new URLSearchParams(query === -1 ? '' : raw.slice(query + 1))
  const first = `/${pathname.split('/').filter(Boolean)[0] ?? ''}`

  if (first === '/settings') {
    return settingsLocationEntries(params)
  }

  const entries = [`route:${first}`]
  const section = params.get('section')

  if (first === '/command-center' && section) {
    entries.push(`command-center:${section}`)
  }

  return entries
}

export const appPathAllowed = (path: string, filter: (entryId: string) => boolean): boolean =>
  appPathEntries(path).every(filter)

export interface DeepLinkLike {
  kind: string
  name: string
  params: Record<string, string>
}

/**
 * The entries an OS deep link reaches: `hermes://open/<path>?…` is the app
 * path; any other kind is `deep-link:<kind>` (and `deep-link:<kind>/<name>`).
 */
export function deepLinkEntries(link: DeepLinkLike): string[] {
  if (link.kind === 'open') {
    const search = new URLSearchParams(link.params ?? {}).toString()

    return appPathEntries(`/${(link.name ?? '').replace(/^\/+/, '')}${search ? `?${search}` : ''}`)
  }

  return [`deep-link:${link.kind}`, ...(link.name ? [`deep-link:${link.kind}/${link.name}`] : [])]
}
