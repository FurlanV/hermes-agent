/**
 * A package's sources in its Capabilities card (F11): "Sources" expands to one row per part, with its label, summary
 * and a switch. A switch goes to Electron main, which runs `athena config tool <id>/<part> on|off`; like a package's
 * switch it applies to new chats (and off, at the next call of an open chat, through the guard). While the package
 * is off its sources are off too, and their switches wait for it. A package without parts shows nothing here.
 */

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { notifyError } from '@/store/notifications'

import type { CatalogCard } from './catalog'
import type { PartCard } from './catalog-parts'
import { reloadPackageServers } from './mcp-reload'
import { setPartEnabled } from './tool-prefs'

function PartRow({ busy, onToggle, row, title }: { busy: boolean; onToggle: (on: boolean) => void; row: PartCard; title: string }) {
  return (
    <li className="flex items-start gap-3 py-1" data-part={row.part.id} data-slot="athena-catalog-part">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{row.part.label}</p>
        <p className="text-[0.68rem] text-(--ui-text-secondary)">{row.part.summary}</p>
      </div>
      <label className="inline-flex shrink-0 items-center gap-2 text-xs text-(--ui-text-secondary)">
        <span>{row.on ? 'On' : 'Off'}</span>
        <Switch
          aria-label={`${row.part.label} in ${title}`}
          checked={row.on}
          disabled={busy || row.packageOff || row.managed}
          onCheckedChange={onToggle}
          size="xs"
        />
      </label>
    </li>
  )
}

export function PartSwitches({ card, view }: { card: CatalogCard; view: 'browse' | 'installed' }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<null | string>(null)
  const { entry, parts } = card

  if (parts.length === 0 || view !== 'installed') {
    return null
  }

  const listId = `athena-catalog-parts-${entry.id}`

  const toggle = async (row: PartCard, on: boolean) => {
    setBusy(true)

    try {
      const result = await setPartEnabled(entry.id, row.part.id, on)

      if (!result.ok) {
        notifyError(new Error(result.message || 'The change was not saved'), 'Could not change this source')

        return
      }

      setNote(result.applied ? 'Applies to new chats' : result.message || 'Applies to new chats after the next sync')

      if (on && result.applied) {
        await reloadPackageServers([entry.id]) // the pinned tools of a running daemon's server changed
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1" data-slot="athena-catalog-parts">
      <Button
        aria-controls={listId}
        aria-expanded={open}
        className="h-auto px-0 text-[0.68rem]"
        onClick={() => setOpen(value => !value)}
        size="xs"
        variant="text"
      >
        {open ? 'Hide sources' : `Sources (${parts.length})`}
      </Button>
      {open && (
        <div id={listId}>
          {parts[0].packageOff && (
            <p className="text-[0.68rem] text-(--ui-text-tertiary)" data-slot="athena-catalog-parts-off">
              {entry.title} is off, so its sources are off too. Turn it on to use them.
            </p>
          )}
          <ul className="divide-y divide-(--ui-stroke-secondary)">
            {parts.map(row => (
              <PartRow busy={busy} key={row.ref} onToggle={on => void toggle(row, on)} row={row} title={entry.title} />
            ))}
          </ul>
          {note && (
            <p className="text-[0.68rem] text-(--ui-text-secondary)" data-slot="athena-catalog-parts-note" role="status">
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
