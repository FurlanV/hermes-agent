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
 *
 * Access (F03 slice 26): a gateway package the user holds no grant for (`package-access.json`, from the platform at
 * each sync) shows Request access in place of Install or the switch, then Requested. Requesting also installs it, so
 * the card turns on by itself once an administrator grants it and the next sync brings the grant. Scopes still
 * waiting show as pending. The capability gateway decides every call whatever the page shows.
 *
 * Settings (F03 slice 27): an installed package that declares `settings` shows a form in its details (text, choice,
 * toggle, number with bounds). Values are checked here and again by `athena config settings <id>`, stored in
 * tool-prefs.json and sent to the package with each call of new chats. A secret-typed setting is never shown.
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
  type CatalogSetting,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  classificationOf,
  groupByCategory,
  groupCards,
  isBuiltIn,
  isSecretSetting,
  packageTools,
  type PackageUpdate,
  requestToolsUrl,
  sendsLine,
  settingProblem,
  settingValue,
  statusBanner,
  toolsMode,
  worksBestWithLine
} from './catalog'
import { type CurrentCatalog, currentCatalog, refreshCatalog } from './catalog-source'
import { LearnedSkills } from './learned-skills'
import { MCP_KINDS, needsMcpReload, reloadPackageServers } from './mcp-reload'
import {
  $installedPackages,
  $packageAccess,
  $packageSettings,
  $toolPrefs,
  loadInstalledPackages,
  loadPackageAccess,
  loadPackageSettings,
  loadToolPrefs,
  packageAction,
  savePackageSettings,
  type SettingValue,
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
  /** The daemon said this package's server did not connect (R01 slice 27). */
  unreachable: boolean
  onInstall: () => void
  onAccept: () => void
  onCheck: () => void
  onRemove: () => void
  onRequest: (reason: string) => void
  onToggle: (on: boolean) => void
  view: CatalogView
}

/** Request access, with an optional reason for the admins (slice 26). */
function RequestForm({ busy, onCancel, onSend, title }: { busy: boolean; onCancel: () => void; onSend: (reason: string) => void; title: string }) {
  const [reason, setReason] = useState('')

  return (
    <form
      className="mt-1 flex flex-wrap items-center gap-2"
      data-slot="athena-catalog-request-form"
      onSubmit={event => {
        event.preventDefault()
        onSend(reason)
      }}
    >
      <input
        aria-label={`Why you need ${title} (optional)`}
        className="min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.68rem]"
        maxLength={500}
        onChange={event => setReason(event.target.value)}
        placeholder="Why you need it (optional)"
        value={reason}
      />
      <Button disabled={busy} size="xs" type="submit" variant="secondary">
        Send request
      </Button>
      <Button onClick={onCancel} size="xs" type="button" variant="text">
        Cancel
      </Button>
    </form>
  )
}

type Draft = Record<string, boolean | number | string>

/** The package's settings form (slice 27): one field per setting, checked before it is saved. */
function SettingsForm({ id, settings }: { id: string; settings: CatalogSetting[] }) {
  const stored = useStore($packageSettings)[id]
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(settings.map(s => [s.id, settingValue(s, stored)])))
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({})
  const [status, setStatus] = useState<null | string>(null)
  const [saving, setSaving] = useState(false)

  if (settings.some(isSecretSetting)) {
    return (
      <p className="text-[0.68rem] text-destructive" data-slot="athena-catalog-settings-refused" role="alert">
        This package asks for a secret setting, which Athena does not allow. Ask its publisher to remove it.
      </p>
    )
  }

  const save = async () => {
    const found = Object.fromEntries(
      settings.flatMap(s => {
        const problem = settingProblem(s, draft[s.id])

        return problem ? [[s.id, `${s.title} ${problem}`]] : []
      })
    )

    setProblems(found)
    setStatus(null)

    if (Object.keys(found).length > 0) {
      return
    }

    // Only what differs from the default is stored: a default stays the publisher's.
    const values: Record<string, SettingValue> = Object.fromEntries(
      settings.filter(s => draft[s.id] !== s.default).map(s => [s.id, draft[s.id]])
    )

    setSaving(true)

    try {
      const result = await savePackageSettings(id, values)
      setStatus(result.ok ? 'Saved. Applies to new chats.' : result.message || 'The settings were not saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="grid gap-1.5"
      data-slot="athena-catalog-settings"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      {settings.map(setting => {
        const fieldId = `athena-setting-${id}-${setting.id}`
        const value = draft[setting.id]
        const set = (next: boolean | number | string) => setDraft(state => ({ ...state, [setting.id]: next }))

        return (
          <div className="grid gap-0.5" data-setting={setting.id} key={setting.id}>
            <label className="text-(--ui-text-secondary)" htmlFor={fieldId}>
              {setting.title}
            </label>
            {setting.type === 'toggle' ? (
              <Switch checked={value === true} id={fieldId} onCheckedChange={set} size="xs" />
            ) : setting.type === 'choice' ? (
              <select
                className="rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-0.5"
                id={fieldId}
                onChange={event => set(event.target.value)}
                value={String(value)}
              >
                {(setting.choices ?? []).map(choice => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-0.5"
                id={fieldId}
                max={setting.type === 'number' ? (setting.maximum ?? undefined) : undefined}
                min={setting.type === 'number' ? (setting.minimum ?? undefined) : undefined}
                onChange={event => set(setting.type === 'number' ? (event.target.value === '' ? Number.NaN : Number(event.target.value)) : event.target.value)}
                type={setting.type === 'number' ? 'number' : 'text'}
                value={typeof value === 'number' && Number.isNaN(value) ? '' : String(value)}
              />
            )}
            {setting.description && <span className="text-(--ui-text-tertiary)">{setting.description}</span>}
            {problems[setting.id] && (
              <span className="text-destructive" data-slot="athena-catalog-setting-problem" role="alert">
                {problems[setting.id]}
              </span>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <Button disabled={saving} size="xs" type="submit" variant="secondary">
          Save settings
        </Button>
        {status && (
          <span className="text-(--ui-text-secondary)" data-slot="athena-catalog-settings-status" role="status">
            {status}
          </span>
        )}
      </div>
    </form>
  )
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
      {card.installed && (entry.settings ?? []).length > 0 && (
        <>
          <dt className="text-(--ui-text-tertiary)">Settings</dt>
          <dd>
            <SettingsForm id={entry.id} settings={entry.settings ?? []} />
          </dd>
        </>
      )}
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

function CatalogCardView({ busy, card, note, onAccept, onCheck, onInstall, onRemove, onRequest, onToggle, unreachable, view }: CardProps) {
  const { access, entry, experimental, installed, managed, on, removable, update } = card
  const banner = statusBanner(entry)
  const worksBestWith = worksBestWithLine(card)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const Icon = ICONS[entry.icon] ?? Wrench
  const detailsId = `athena-catalog-details-${view}-${entry.id}`
  const classification = classificationOf(entry)

  let control: ReactNode

  const requestButton = (
    <Button
      aria-label={`Request access to ${entry.title}`}
      data-slot="athena-catalog-request-access"
      disabled={busy || entry.status === 'withdrawn'}
      onClick={() => setAsking(true)}
      size="xs"
      variant="secondary"
    >
      Request access
    </Button>
  )

  if (access?.blocked && !(view === 'browse' && installed)) {
    control = access.suspended ? (
      <span className="shrink-0 text-xs text-(--ui-text-tertiary)" data-slot="athena-catalog-suspended">
        Suspended
      </span>
    ) : access.missing.length === 0 ? (
      <span
        className="shrink-0 text-xs text-(--ui-text-tertiary)"
        data-slot="athena-catalog-requested"
        title="An administrator has been asked; it turns on once they grant it"
      >
        Requested
      </span>
    ) : (
      requestButton
    )
  } else if (view === 'browse') {
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
          {access && !access.blocked && (access.pending.length > 0 || access.missing.length > 0) && (
            <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-pending">
              Not granted yet: {[...access.pending.map(t => `${t} (requested)`), ...access.missing].join(', ')}
              {access.missing.length > 0 && !asking && (
                <Button className="ml-2 h-auto px-0 text-[0.68rem]" disabled={busy} onClick={() => setAsking(true)} size="xs" variant="text">
                  Request access
                </Button>
              )}
            </p>
          )}
          {access?.suspended && (
            <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-suspended-note" role="note">
              Suspended by Athena&apos;s administrators: new chats leave it out.
            </p>
          )}
          {asking && (
            <RequestForm
              busy={busy}
              onCancel={() => setAsking(false)}
              onSend={reason => {
                setAsking(false)
                onRequest(reason)
              }}
              title={entry.title}
            />
          )}
          {worksBestWith && (
            <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-works-best-with">
              {worksBestWith}
            </p>
          )}
          {unreachable && on && (
            <p
              className="mt-1 rounded bg-amber-500/10 px-2 py-1 text-[0.68rem] text-amber-700 dark:text-amber-300"
              data-slot="athena-catalog-unreachable"
              role="status"
            >
              Not connected: {entry.title} could not be reached. Athena tries again every few minutes, and new chats
              get its tools once it connects.
              <Button
                aria-label={`Check ${entry.title} again`}
                className="ml-2 h-auto px-0 text-[0.68rem]"
                data-slot="athena-catalog-check-again"
                disabled={busy}
                onClick={onCheck}
                size="xs"
                variant="text"
              >
                Check again
              </Button>
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
  const access = useStore($packageAccess)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<CatalogView>('installed')
  const [category, setCategory] = useState<CatalogCategory | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({})
  const [unreachable, setUnreachable] = useState<ReadonlySet<string>>(new Set())
  const [current, setCurrent] = useState<CurrentCatalog>(() => currentCatalog())
  const config = useMemo(() => snapshot?.config ?? {}, [snapshot])
  const role = snapshot?.role ?? null

  // One read of main's prefs file per mount; main owns the file and answers each change with the new state.
  useEffect(() => {
    void loadToolPrefs()
    void loadInstalledPackages()
    void loadPackageAccess()
    void loadPackageSettings()
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
    () => catalogCards(config, prefs, current.catalog, installed, role, access),
    [config, prefs, current, installed, role, access]
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

  // Ask the daemon to connect what is pinned and learn which packages did not connect (mcp-reload.ts). True when
  // `id` is connected as far as the daemon says; null when the daemon could not be asked.
  const reloadServers = async (id: string): Promise<boolean | null> => {
    const packages = Object.values(current.catalog.entries)
      .filter(entry => MCP_KINDS.has(entry.kind))
      .map(entry => entry.id)

    const result = await reloadPackageServers(packages)

    if (!result.sent) {
      return null
    }

    const down = new Set(result.unreachable ?? [id])

    setUnreachable(down)

    return !down.has(id)
  }

  // A newly pinned MCP server reaches the running daemon on reload.mcp, not at the next new chat.
  const reloadIfNeeded = async (id: string, on: boolean) => {
    const entry = current.catalog.entries[id]

    if (!entry || !needsMcpReload(entry, on)) {
      return
    }

    const connected = await reloadServers(id)

    if (connected === null) {
      note(id, 'Applies to new chats within a minute')
    } else if (!connected) {
      note(id, '') // the card's "Not connected" line says what happens next
    }
  }

  const checkAgain = async (id: string) => {
    const connected = await withBusy(id, () => reloadServers(id))

    note(
      id,
      connected === null ? 'Athena could not check right now' : connected ? 'Connected. Applies to new chats' : 'Still not connected'
    )
  }

  const toggle = async (id: string, on: boolean) => {
    const result = await withBusy(id, () => setToolEnabled(id, on))

    if (!result.ok) {
      notifyError(new Error(result.message || 'The change was not saved'), 'Could not change this tool')

      return
    }

    note(id, result.applied ? 'Applies to new chats' : result.message || 'Applies to new chats after the next sync')

    if (!on) {
      setUnreachable(state => new Set([...state].filter(other => other !== id)))
    }

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

  const request = async (id: string, reason: string) => {
    const result = await withBusy(id, () =>
      packageAction(id, 'request', undefined, reason.trim() ? { reason: reason.trim() } : {})
    )

    if (!result.ok) {
      notifyError(new Error(result.message || 'Access was not requested'), 'Could not request access')

      return
    }

    note(id, 'Requested. It turns on by itself once an administrator grants it')
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
                  onCheck={() => void checkAgain(card.entry.id)}
                  onInstall={() => void install(card.entry.id)}
                  onRemove={() => void remove(card.entry.id)}
                  onRequest={reason => void request(card.entry.id, reason)}
                  onToggle={on => void toggle(card.entry.id, on)}
                  unreachable={unreachable.has(card.entry.id)}
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
