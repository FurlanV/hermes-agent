/**
 * The Athena Capabilities page (F02 slice 28, plan section D "What users see"; F03 slice 20 Browse and Installed):
 * one page of the role's catalog entries instead of the stock Skills, Plugins, Connectors and Toolsets tabs, while
 * `managed.tools` is `enforce` or `report`.
 *
 * - **Installed** (the default view): what the user has (built-ins, packages the admin installed for the role, and
 *   packages installed here), grouped and searchable, each with title, version, summary, what leaves the laptop and
 *   a switch, or "Managed" for locked and admin-decided entries.
 * - **Browse**: every package the role may see, grouped Built-in, Agents, Databases, Skills, with search (name,
 *   publisher, summary, tools) and a category filter. A card shows the publisher, version, summary, the "Sends:"
 *   line and a data-classification badge, and Install for a package that is not installed. Built-ins have no
 *   Install. Details add the tools, scopes, review note and example prompts.
 *
 * A switch goes to Electron main, which runs `athena config tool <id> on|off`; Install runs `athena config tool <id>
 * install` (version and hash recorded in tool-prefs.json; nothing is downloaded from the publisher). Either reaches
 * new chats. There is no add, import, URL or JSON editor anywhere on the page.
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Switch } from '@/components/ui/switch'
import { openExternalLink } from '@/lib/external-link'
import {
  Book,
  Brain,
  CheckCircle2,
  Cpu,
  FileText,
  FolderOpen,
  Globe,
  type IconComponent,
  LayoutDashboard,
  Lock,
  MessageQuestion,
  Search,
  Starmap,
  Terminal,
  Users,
  Wrench
} from '@/lib/icons'
import { notifyError } from '@/store/notifications'

import branding from '../branding.json'
import { useClientConfig } from '../managed/client-config'

import {
  type CatalogCard,
  catalogCards,
  type CatalogCategory,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  classificationOf,
  groupByCategory,
  groupCards,
  isBuiltIn,
  packageTools,
  type PackageUpdate,
  requestToolsUrl,
  sendsLine,
  statusBanner,
  toolsMode,
  worksBestWithLine
} from './catalog'
import { type CurrentCatalog, currentCatalog, refreshCatalog } from './catalog-source'
import { LearnedSkills } from './learned-skills'
import { needsMcpReload, reloadPackageServers } from './mcp-reload'
import {
  $installedPackages,
  $toolPrefs,
  loadInstalledPackages,
  loadToolPrefs,
  packageAction,
  setToolEnabled
} from './tool-prefs'

/** The catalog's `icon` names (lucide-style) mapped onto the app's icon set. */
const ICONS: Record<string, IconComponent> = {
  'book-search': Book,
  brain: Brain,
  code: Cpu,
  'file-search': Search,
  'file-text': FileText,
  'folder-open': FolderOpen,
  globe: Globe,
  'list-checks': CheckCircle2,
  'message-question': MessageQuestion,
  sparkles: Starmap,
  table: LayoutDashboard,
  terminal: Terminal,
  users: Users
}

const CLASSIFICATION_BADGE = {
  confidential: 'warn',
  internal: 'muted',
  public: 'success',
  restricted: 'destructive'
} as const

/** Whether Capabilities shows the curated catalog: an Athena config with `managed.tools` other than `off`. */
export function useCuratedCapabilities(): boolean {
  const snapshot = useClientConfig()

  // No snapshot means no Athena bridge (a browser or a test host): the stock page.
  return snapshot !== null && toolsMode(snapshot.config) !== 'off'
}

export type CatalogView = 'browse' | 'installed'

interface CardProps {
  busy: boolean
  card: CatalogCard
  note: null | string
  onInstall: () => void
  onAccept: () => void
  onRemove: () => void
  onToggle: (on: boolean) => void
  view: CatalogView
}

function CardDetails({ card, id }: { card: CatalogCard; id: string }) {
  const { entry } = card
  const tools = packageTools(entry)
  const scopes = entry.scopes ?? []
  const examples = entry.examples ?? []

  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.68rem]" data-slot="athena-catalog-details" id={id}>
      <dt className="text-(--ui-text-tertiary)">Tools</dt>
      <dd className="font-mono">{tools.join(', ') || '—'}</dd>
      {entry.provides.toolsets.length > 0 && (
        <>
          <dt className="text-(--ui-text-tertiary)">Toolsets</dt>
          <dd className="font-mono">{entry.provides.toolsets.join(', ')}</dd>
        </>
      )}
      {scopes.length > 0 && (
        <>
          <dt className="text-(--ui-text-tertiary)">Scopes</dt>
          <dd data-slot="athena-catalog-scopes">
            <ul>
              {scopes.map(scope => (
                <li key={scope.id}>
                  {scope.title} <span className="text-(--ui-text-tertiary)">({scope.classification})</span>:{' '}
                  <span className="font-mono">{scope.tools.join(', ')}</span>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {entry.publisher && (
        <>
          <dt className="text-(--ui-text-tertiary)">Publisher</dt>
          <dd>
            {entry.publisher.name} · {entry.publisher.team} · {entry.publisher.contact}
          </dd>
        </>
      )}
      <dt className="text-(--ui-text-tertiary)">Network</dt>
      <dd>{entry.permissions.network.join(', ') || 'none'}</dd>
      <dt className="text-(--ui-text-tertiary)">Files</dt>
      <dd>{entry.permissions.filesystem}</dd>
      <dt className="text-(--ui-text-tertiary)">Runs code</dt>
      <dd>{entry.permissions.executes_code ? 'yes' : 'no'}</dd>
      {entry.results === 'live-only' && (
        <>
          <dt className="text-(--ui-text-tertiary)">Results</dt>
          <dd>Read live each time; Athena keeps no copy</dd>
        </>
      )}
      <dt className="text-(--ui-text-tertiary)">Review</dt>
      <dd data-slot="athena-catalog-review">
        {entry.review.notes}{' '}
        <span className="text-(--ui-text-tertiary)">
          ({entry.review.by}, {entry.review.at})
        </span>
      </dd>
      {examples.length > 0 && (
        <>
          <dt className="text-(--ui-text-tertiary)">Try</dt>
          <dd data-slot="athena-catalog-examples">
            <ul>
              {examples.map(example => (
                <li key={example}>“{example}”</li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  )
}

function UpdateLine({ busy, onAccept, title, update }: { busy: boolean; onAccept: () => void; title: string; update: PackageUpdate }) {
  if (update.kind === 'updated') {
    return (
      <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-updated">
        Updated from v{update.from}
      </p>
    )
  }

  if (update.kind === 'held') {
    return (
      <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-held" role="note">
        Not updated: {update.reason}. Off in new chats until Athena is updated.
      </p>
    )
  }

  return (
    <div className="mt-1 rounded bg-amber-500/10 px-2 py-1 text-[0.68rem]" data-slot="athena-catalog-update-review" role="note">
      <p className="font-medium">Update needs review: v{update.version} is off in new chats until you accept it.</p>
      <ul className="list-disc pl-4">
        {update.changes.map(change => (
          <li key={change}>{change}</li>
        ))}
      </ul>
      <Button aria-label={`Accept the update of ${title}`} className="mt-1" disabled={busy} onClick={onAccept} size="xs" variant="secondary">
        Accept
      </Button>
    </div>
  )
}

function CatalogCardView({ busy, card, note, onAccept, onInstall, onRemove, onToggle, view }: CardProps) {
  const { entry, experimental, installed, managed, on, removable, update } = card
  const banner = statusBanner(entry)
  const worksBestWith = worksBestWithLine(card)
  const [open, setOpen] = useState(false)
  const Icon = ICONS[entry.icon] ?? Wrench
  const detailsId = `athena-catalog-details-${view}-${entry.id}`
  const classification = classificationOf(entry)

  let control: ReactNode

  if (view === 'browse') {
    control = installed ? (
      <span className="shrink-0 text-xs text-(--ui-text-tertiary)" data-slot="athena-catalog-installed">
        {isBuiltIn(entry) ? 'Built-in' : 'Installed'}
      </span>
    ) : (
      <Button
        aria-label={`Install ${entry.title}`}
        data-slot="athena-catalog-install"
        disabled={busy || entry.status === 'withdrawn'}
        onClick={onInstall}
        size="xs"
        variant="secondary"
      >
        Install
      </Button>
    )
  } else if (managed) {
    control = (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-xs text-(--ui-text-tertiary)"
        data-slot="athena-catalog-managed"
        title="Your administrator decides whether this is on"
      >
        Managed <Lock className="size-3.5" />
      </span>
    )
  } else {
    control = (
      <label className="inline-flex shrink-0 items-center gap-2 text-xs text-(--ui-text-secondary)">
        <span>{on ? 'On' : 'Off'}</span>
        <Switch aria-label={entry.title} checked={on} disabled={busy} onCheckedChange={onToggle} size="xs" />
      </label>
    )
  }

  return (
    <li
      className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-2.5"
      data-entry={entry.id}
      data-slot="athena-catalog-card"
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-(--ui-text-tertiary)" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium">{entry.title}</h3>
            <span className="text-[0.68rem] tabular-nums text-(--ui-text-tertiary)">v{entry.version}</span>
            {experimental && (
              <Badge data-slot="athena-experimental-badge" size="xs" variant="warn">
                Experimental
              </Badge>
            )}
            {classification && (
              <Badge data-slot="athena-classification-badge" size="xs" variant={CLASSIFICATION_BADGE[classification]}>
                {classification}
              </Badge>
            )}
          </div>
          {entry.publisher && (
            <p className="text-[0.68rem] text-(--ui-text-tertiary)" data-slot="athena-catalog-publisher">
              {entry.publisher.name}
            </p>
          )}
          <p className="text-xs text-(--ui-text-secondary)">{entry.summary}</p>
          {banner && (
            <p
              className={
                banner.kind === 'withdrawn'
                  ? 'mt-1 rounded bg-destructive/10 px-2 py-1 text-[0.68rem] text-destructive'
                  : 'mt-1 rounded bg-amber-500/10 px-2 py-1 text-[0.68rem] text-amber-700 dark:text-amber-300'
              }
              data-slot={`athena-catalog-${banner.kind}`}
              role="note"
            >
              {banner.text}
            </p>
          )}
          <p className="text-[0.68rem] text-(--ui-text-tertiary)" data-slot="athena-catalog-sends">
            {sendsLine(entry)}
          </p>
          {update && <UpdateLine busy={busy} onAccept={onAccept} title={entry.title} update={update} />}
          {worksBestWith && (
            <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-works-best-with">
              {worksBestWith}
            </p>
          )}
          {note && (
            <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-note" role="status">
              {note}
            </p>
          )}
          <Button
            aria-controls={detailsId}
            aria-expanded={open}
            className="mt-1 h-auto px-0 text-[0.68rem]"
            onClick={() => setOpen(value => !value)}
            size="xs"
            variant="text"
          >
            {open ? 'Hide details' : 'Details'}
          </Button>
          {view === 'installed' && removable && (
            <Button
              aria-label={`Remove ${entry.title}`}
              className="mt-1 ml-3 h-auto px-0 text-[0.68rem]"
              data-slot="athena-catalog-remove"
              disabled={busy}
              onClick={onRemove}
              size="xs"
              variant="text"
            >
              Remove
            </Button>
          )}
          {open && <CardDetails card={card} id={detailsId} />}
        </div>
        {control}
      </div>
    </li>
  )
}

/** The page's diagnostics line: the catalog version and where it came from (F03 slices 02 and 19). */
export function CatalogDiagnostics({ current }: { current: CurrentCatalog }) {
  return (
    <p className="mt-6 text-[0.68rem] text-(--ui-text-tertiary)" data-slot="athena-catalog-diagnostics">
      Catalog {current.version}
      {current.remoteVersion && ` + remote ${current.remoteVersion}`} · source: {current.source}
      {current.error && <span title={current.error}> ({current.source === 'bundled' ? 'fallback' : current.error})</span>}
      {current.rejected.length > 0 && (
        <span data-slot="athena-catalog-rejected" title={current.rejected.map(r => `${r.id}: ${r.reason}`).join('\n')}>
          {' '}
          · {current.rejected.length} remote {current.rejected.length === 1 ? 'entry' : 'entries'} refused
        </span>
      )}
    </p>
  )
}

function ViewTabs({ onChange, view }: { onChange: (view: CatalogView) => void; view: CatalogView }) {
  return (
    <div aria-label="Capabilities view" className="mb-3 inline-flex gap-1" role="tablist">
      {(['installed', 'browse'] as const).map(id => (
        <Button
          aria-selected={view === id}
          data-slot="athena-catalog-view"
          key={id}
          onClick={() => onChange(id)}
          role="tab"
          size="xs"
          variant={view === id ? 'secondary' : 'text'}
        >
          {id === 'installed' ? 'Installed' : 'Browse'}
        </Button>
      ))}
    </div>
  )
}

function CategoryFilter({
  category,
  onChange
}: {
  category: CatalogCategory | null
  onChange: (category: CatalogCategory | null) => void
}) {
  return (
    <div aria-label="Category" className="mt-2 flex flex-wrap gap-1" role="group">
      {[null, ...CATEGORY_ORDER].map(id => (
        <Button
          aria-pressed={category === id}
          data-slot="athena-catalog-category"
          key={id ?? 'all'}
          onClick={() => onChange(id)}
          size="xs"
          variant={category === id ? 'secondary' : 'chip'}
        >
          {id ? CATEGORY_LABELS[id] : 'All'}
        </Button>
      ))}
    </div>
  )
}

export function AthenaCatalogPage() {
  const snapshot = useClientConfig()
  const prefs = useStore($toolPrefs)
  const installed = useStore($installedPackages)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<CatalogView>('installed')
  const [category, setCategory] = useState<CatalogCategory | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({})
  const [current, setCurrent] = useState<CurrentCatalog>(() => currentCatalog())
  const config = useMemo(() => snapshot?.config ?? {}, [snapshot])
  const role = snapshot?.role ?? null

  // One read of main's prefs file per mount; main owns the file and answers each change with the new state.
  useEffect(() => {
    void loadToolPrefs()
    void loadInstalledPackages()
  }, [])

  // Ask main again on each visit: a remote catalog synced while the app ran shows without a restart.
  useEffect(() => {
    let live = true
    void refreshCatalog().then(next => live && setCurrent(next))

    return () => {
      live = false
    }
  }, [])

  const cards = useMemo(
    () => catalogCards(config, prefs, current.catalog, installed, role),
    [config, prefs, current, installed, role]
  )

  const groups = useMemo(
    () =>
      view === 'installed'
        ? groupCards(
            cards.filter(card => card.installed),
            query
          )
        : groupByCategory(cards, query, category),
    [cards, query, view, category]
  )

  const requestUrl = requestToolsUrl(config)

  const withBusy = async <T,>(id: string, run: () => Promise<T>): Promise<T> => {
    setBusy(state => new Set(state).add(id))

    try {
      return await run()
    } finally {
      setBusy(state => {
        const next = new Set(state)
        next.delete(id)

        return next
      })
    }
  }

  const note = (id: string, text: string) => setNotes(state => ({ ...state, [id]: text }))

  // A newly pinned MCP server reaches the running daemon on reload.mcp, not at the next new chat (mcp-reload.ts).
  const reloadIfNeeded = async (id: string, on: boolean) => {
    const entry = current.catalog.entries[id]

    if (entry && needsMcpReload(entry, on) && !(await reloadPackageServers())) {
      note(id, 'Applies to new chats within a minute')
    }
  }

  const toggle = async (id: string, on: boolean) => {
    const result = await withBusy(id, () => setToolEnabled(id, on))

    if (!result.ok) {
      notifyError(new Error(result.message || 'The change was not saved'), 'Could not change this tool')

      return
    }

    note(id, result.applied ? 'Applies to new chats' : result.message || 'Applies to new chats after the next sync')

    if (result.applied) {
      await reloadIfNeeded(id, on)
    }
  }

  const install = async (id: string) => {
    const result = await withBusy(id, () => packageAction(id, 'install'))

    if (!result.ok) {
      notifyError(new Error(result.message || 'The package was not installed'), 'Could not install this package')

      return
    }

    note(id, 'Installed. Applies to new chats')
    await reloadIfNeeded(id, true)
  }

  const acceptUpdate = async (id: string) => {
    const result = await withBusy(id, () => packageAction(id, 'accept'))

    if (!result.ok) {
      notifyError(new Error(result.message || 'The update was not accepted'), 'Could not accept this update')

      return
    }

    note(id, 'Accepted. Applies to new chats')
    await reloadIfNeeded(id, true)
  }

  const remove = async (id: string) => {
    const result = await withBusy(id, () => packageAction(id, 'remove'))

    if (!result.ok) {
      notifyError(new Error(result.message || 'The package was not removed'), 'Could not remove this package')

      return
    }

    note(id, 'Removed. New chats no longer get it')
  }

  return (
    <section
      className="flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)"
      data-slot="athena-catalog-page"
    >
      <header className="shrink-0 px-6 pb-3 pt-[calc(var(--titlebar-height)+1.5rem)]">
        <h1 className="text-base font-semibold">Capabilities</h1>
        <p className="mb-3 text-xs text-(--ui-text-secondary)">
          Tools approved by {branding.organization} Research IT. Changes apply to new chats.
        </p>
        <ViewTabs onChange={setView} view={view} />
        <SearchField
          aria-label="Search tools"
          containerClassName="max-w-md"
          onChange={setQuery}
          placeholder={view === 'browse' ? 'Search by name, publisher or tool…' : 'Search tools…'}
          value={query}
          variant="box"
        />
        {view === 'browse' && <CategoryFilter category={category} onChange={setCategory} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {groups.length === 0 && (
          <p className="py-6 text-xs text-(--ui-text-tertiary)">
            {cards.length === 0 ? 'No tools are available for your role.' : 'No tools match your search.'}
          </p>
        )}
        {groups.map(({ cards: groupCardsList, group }) => (
          <section aria-label={group} className="mt-4 first:mt-0" data-group={group} key={group}>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-(--ui-text-tertiary)">{group}</h2>
            <ul className="grid gap-2">
              {groupCardsList.map(card => (
                <CatalogCardView
                  busy={busy.has(card.entry.id)}
                  card={card}
                  key={card.entry.id}
                  note={notes[card.entry.id] ?? null}
                  onAccept={() => void acceptUpdate(card.entry.id)}
                  onInstall={() => void install(card.entry.id)}
                  onRemove={() => void remove(card.entry.id)}
                  onToggle={on => void toggle(card.entry.id, on)}
                  view={view}
                />
              ))}
            </ul>
          </section>
        ))}
        {view === 'installed' && <LearnedSkills />}
        {requestUrl && (
          <p className="mt-6 text-xs text-(--ui-text-secondary)" data-slot="athena-catalog-request">
            Need another tool?{' '}
            <a
              className="font-medium text-primary hover:underline"
              href={requestUrl}
              onClick={event => {
                event.preventDefault()
                openExternalLink(requestUrl)
              }}
              rel="noreferrer"
            >
              Ask Research IT ▸
            </a>
          </p>
        )}
        <CatalogDiagnostics current={current} />
      </div>
    </section>
  )
}
