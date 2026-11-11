/**
 * The Athena Capabilities page (F02 slice 28, plan section D "What users see"): one page of the role's catalog
 * entries instead of the stock Skills, Plugins, Connectors and Toolsets tabs, while `managed.tools` is `enforce` or
 * `report`. Cards are grouped and searchable; each shows title, version, summary, what leaves the laptop and a
 * switch, or "Managed" for locked and admin-decided entries. A switch goes to Electron main, which runs
 * `athena config tool` (tool-prefs.json + apply), so the change reaches new chats. There is no add, import, URL or
 * JSON editor anywhere on the page.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

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

import { type CatalogCard, catalogCards, groupCards, requestToolsUrl, sendsLine, toolsMode } from './catalog'
import { type CurrentCatalog, currentCatalog } from './catalog-source'
import { LearnedSkills } from './learned-skills'
import { $toolPrefs, loadToolPrefs, setToolEnabled } from './tool-prefs'

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

/** Whether Capabilities shows the curated catalog: an Athena config with `managed.tools` other than `off`. */
export function useCuratedCapabilities(): boolean {
  const snapshot = useClientConfig()

  // No snapshot means no Athena bridge (a browser or a test host): the stock page.
  return snapshot !== null && toolsMode(snapshot.config) !== 'off'
}

interface CardProps {
  busy: boolean
  card: CatalogCard
  note: null | string
  onToggle: (on: boolean) => void
}

function CatalogCardView({ busy, card, note, onToggle }: CardProps) {
  const { entry, experimental, managed, on } = card
  const [open, setOpen] = useState(false)
  const Icon = ICONS[entry.icon] ?? Wrench
  const detailsId = `athena-catalog-details-${entry.id}`

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
          </div>
          <p className="text-xs text-(--ui-text-secondary)">{entry.summary}</p>
          <p className="text-[0.68rem] text-(--ui-text-tertiary)" data-slot="athena-catalog-sends">
            {sendsLine(entry)}
          </p>
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
          {open && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.68rem]" id={detailsId}>
              <dt className="text-(--ui-text-tertiary)">Tools</dt>
              <dd className="font-mono">{entry.provides.tools.join(', ') || '—'}</dd>
              {entry.provides.toolsets.length > 0 && (
                <>
                  <dt className="text-(--ui-text-tertiary)">Toolsets</dt>
                  <dd className="font-mono">{entry.provides.toolsets.join(', ')}</dd>
                </>
              )}
              <dt className="text-(--ui-text-tertiary)">Network</dt>
              <dd>{entry.permissions.network.join(', ') || 'none'}</dd>
              <dt className="text-(--ui-text-tertiary)">Files</dt>
              <dd>{entry.permissions.filesystem}</dd>
              <dt className="text-(--ui-text-tertiary)">Runs code</dt>
              <dd>{entry.permissions.executes_code ? 'yes' : 'no'}</dd>
              <dt className="text-(--ui-text-tertiary)">Review</dt>
              <dd data-slot="athena-catalog-review">
                {entry.review.notes}{' '}
                <span className="text-(--ui-text-tertiary)">
                  ({entry.review.by}, {entry.review.at})
                </span>
              </dd>
            </dl>
          )}
        </div>
        {managed ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs text-(--ui-text-tertiary)"
            data-slot="athena-catalog-managed"
            title="Your administrator decides whether this is on"
          >
            Managed <Lock className="size-3.5" />
          </span>
        ) : (
          <label className="inline-flex shrink-0 items-center gap-2 text-xs text-(--ui-text-secondary)">
            <span>{on ? 'On' : 'Off'}</span>
            <Switch
              aria-label={entry.title}
              checked={on}
              disabled={busy}
              onCheckedChange={onToggle}
              size="xs"
            />
          </label>
        )}
      </div>
    </li>
  )
}

/** The page's diagnostics line: the catalog version and where it came from (F03 slice 02). */
export function CatalogDiagnostics({ current }: { current: CurrentCatalog }) {
  return (
    <p className="mt-6 text-[0.68rem] text-(--ui-text-tertiary)" data-slot="athena-catalog-diagnostics">
      Catalog {current.version} · source: {current.source}
      {current.error && <span title={current.error}> (fallback)</span>}
    </p>
  )
}

export function AthenaCatalogPage() {
  const snapshot = useClientConfig()
  const prefs = useStore($toolPrefs)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({})
  const config = useMemo(() => snapshot?.config ?? {}, [snapshot])

  // One read of main's prefs file per mount; main owns the file and answers each toggle with the new map.
  useEffect(() => {
    void loadToolPrefs()
  }, [])

  const current = useMemo(() => currentCatalog(), [])
  const cards = useMemo(() => catalogCards(config, prefs, current.catalog), [config, prefs, current])
  const groups = useMemo(() => groupCards(cards, query), [cards, query])
  const requestUrl = requestToolsUrl(config)

  const toggle = async (id: string, on: boolean) => {
    setBusy(current => new Set(current).add(id))
    const result = await setToolEnabled(id, on)
    setBusy(current => {
      const next = new Set(current)
      next.delete(id)

      return next
    })

    if (!result.ok) {
      notifyError(new Error(result.message || 'The change was not saved'), 'Could not change this tool')

      return
    }

    setNotes(current => ({
      ...current,
      [id]: result.applied ? 'Applies to new chats' : result.message || 'Applies to new chats after the next sync'
    }))
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
        <SearchField
          aria-label="Search tools"
          containerClassName="max-w-md"
          onChange={setQuery}
          placeholder="Search tools…"
          value={query}
          variant="box"
        />
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
                  onToggle={on => void toggle(card.entry.id, on)}
                />
              ))}
            </ul>
          </section>
        ))}
        <LearnedSkills />
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
