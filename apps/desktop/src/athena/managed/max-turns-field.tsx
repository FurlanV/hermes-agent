/**
 * Max agent steps with the admin's ceiling (F02 slice 24, row S70a).
 *
 * `agent.max_turns` stays the user's: the value they pick is saved to their own hermes config like any other
 * field. The Settings field takes whole numbers from 10 to the role's `models.max_turns_limit` (the renderer's
 * client config, default 90), says so under the label, and refuses anything else. A draft is saved when the field
 * loses focus (or on Enter); an out-of-range or non-number one is flagged while typed, never saved, and goes back to
 * the saved value with a note saying why.
 *
 * The applier is the real control: `athena config apply` pins the effective value at the ceiling when the value
 * that would stand is above it or unlimited (athena `athena_shipper/turn_limit.py`), so a hand-edited config
 * cannot go past it either.
 *
 * The upstream hook is one call in `ConfigField` (`src/app/settings/config-field.tsx`): `athenaConfigField`
 * returns this field for `agent.max_turns`, or null to keep the generic control (any other key, and the stock
 * variant, where the managed client is inert).
 */

import { type ReactNode, useEffect, useId, useState } from 'react'

import { ListRow } from '@/app/settings/primitives'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import branding from '../branding.json'

import { $clientConfig, type ClientConfigSnapshot, useClientConfig } from './client-config'

export const MAX_TURNS_KEY = 'agent.max_turns'
/** The field's floor. */
export const MIN_MAX_TURNS = 10
/** `models.max_turns_limit` when the config has none (athena_schemas `ClientModels`). */
export const DEFAULT_MAX_TURNS_LIMIT = 90

export interface MaxTurnsRange {
  max: number
  min: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The role's ceiling from a client config document: `models.max_turns_limit`, else 90. */
export function maxTurnsLimit(config: unknown): number {
  const models = isRecord(config) ? config.models : undefined
  const limit = isRecord(models) ? models.max_turns_limit : undefined

  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_MAX_TURNS_LIMIT
}

/** 10 to the ceiling. A ceiling under 10 (the schema allows 1) is the whole range. */
export function maxTurnsRange(snapshot: ClientConfigSnapshot | null): MaxTurnsRange {
  const max = maxTurnsLimit(snapshot?.config)

  return { max, min: Math.min(MIN_MAX_TURNS, max) }
}

export type MaxTurnsCheck = { ok: false; reason: string } | { ok: true; value: number }

/** Is a typed draft a whole number within the range? */
export function checkMaxTurns(draft: string, { max, min }: MaxTurnsRange): MaxTurnsCheck {
  const text = draft.trim()
  const value = Number(text)

  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, reason: `Enter a whole number from ${min} to ${max}.` }
  }

  return { ok: true, value }
}

export function maxTurnsRangeText({ max, min }: MaxTurnsRange): string {
  return min === max
    ? `Fixed at ${max} by ${branding.organization}.`
    : `${min} to ${max} steps. ${branding.organization} sets the upper limit.`
}

/** The saved value as the field shows it: a positive whole number, else blank (unset or unlimited). */
function savedDraft(value: unknown): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN

  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : ''
}

export interface AthenaFieldProps {
  dataTour: string
  description?: ReactNode
  label: string
  onChange: (value: unknown) => void
  value: unknown
}

export function MaxTurnsField({ dataTour, description, label, onChange, value }: AthenaFieldProps) {
  const range = maxTurnsRange(useClientConfig())
  const saved = savedDraft(value)
  const [draft, setDraft] = useState(saved)
  const [focused, setFocused] = useState(false)
  const [notice, setNotice] = useState<null | string>(null)
  const rangeId = useId()

  useEffect(() => {
    if (!focused) {
      setDraft(saved)
    }
  }, [focused, saved])

  const check = checkMaxTurns(draft, range)
  const refusal = draft !== saved && !check.ok ? check.reason : notice

  const commit = () => {
    setFocused(false)

    if (draft === saved) {
      return
    }

    if (check.ok) {
      onChange(check.value)

      return
    }

    setNotice(`Not saved: ${check.reason}`)
    setDraft(saved)
  }

  return (
    <ListRow
      action={
        <div className="grid gap-1 @2xl:justify-items-end">
          <Input
            aria-describedby={rangeId}
            aria-invalid={refusal ? true : undefined}
            aria-label={label}
            className={cn('text-xs', refusal && 'border-destructive')}
            data-athena-max-turns=""
            inputMode="numeric"
            max={range.max}
            min={range.min}
            onBlur={commit}
            onChange={event => {
              setNotice(null)
              setDraft(event.target.value)
            }}
            onFocus={() => setFocused(true)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            placeholder={String(range.max)}
            step={1}
            type="number"
            value={draft}
          />
          {refusal ? (
            <span className="text-xs text-destructive" role="alert">
              {refusal}
            </span>
          ) : null}
        </div>
      }
      data-tour={dataTour}
      description={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {description}
          <span data-athena-max-turns-range="" id={rangeId}>
            {maxTurnsRangeText(range)}
          </span>
        </span>
      }
      title={label}
    />
  )
}

/**
 * The Athena control for a config field, or null to keep the generic one. `ConfigField` calls it with what it has
 * already resolved (label, description, tour handle).
 */
export function athenaConfigField(schemaKey: string, props: AthenaFieldProps): ReactNode | null {
  if (schemaKey !== MAX_TURNS_KEY || $clientConfig.get()?.variant === 'stock') {
    return null
  }

  return <MaxTurnsField {...props} />
}
