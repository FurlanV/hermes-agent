/**
 * Reasoning effort per model (F02 slice 23; audit rows S08a and S120, kept).
 *
 * Under `managed.models: enforce`, the composer reasoning pill (and the same
 * options in each model row's submenu), Settings › Model's reasoning select
 * and `/reasoning` offer only the selected model's `reasoning.levels` from the
 * client config:
 * - `none` in the list is the Thinking toggle (off); the other levels are the
 *   effort radio, in the config's order;
 * - a model whose only level is `none` shows "Not available for this model yet";
 * - `models.reasoning_control: off` turns the control off: no pill, no
 *   Settings row, and `/reasoning` answers that it is not available;
 * - switching model (or a new config) resets a level the model does not offer
 *   to the model's default, for every open session (`model-reasoning-reset.ts`).
 * The model gateway clamps the level again (`reasoning_levels` per alias).
 * Under `report` and `off`, and with no config, the stock control stands.
 */

import { useStore } from '@nanostores/react'

import {
  findModelEntry,
  type ManagedModels,
  modelReasoning,
  normalizeEffort,
  REASONING_LADDER
} from '../../../electron/athena/model-policy'

import { $managedModels, enforcedModels } from './model-policy'

export const REASONING_UNAVAILABLE = 'Not available for this model yet'
export const REASONING_CONTROL_OFF = 'Reasoning effort is not available.'

export type ManagedReasoning =
  /** The control is off (`models.reasoning_control: off`): nothing to show. */
  | { state: 'off' }
  /** The model takes no reasoning (only `none`), or is not on the list. */
  | { state: 'unavailable' }
  /** `efforts`: the radio's levels (not `none`); `thinkingToggle`: whether `none` is offered. */
  | { defaultLevel: string; efforts: readonly string[]; state: 'levels'; thinkingToggle: boolean }

/** The control for a model under the managed list, or null for the stock control (not enforced, or no model yet). */
export function managedReasoning(model: string, models: ManagedModels | null = enforcedModels()): ManagedReasoning | null {
  if (!models || !model.trim()) {
    return null
  }

  if (!models.reasoningControl) {
    return { state: 'off' }
  }

  const reasoning = modelReasoning(models, model)
  const efforts = (reasoning?.levels ?? []).filter(level => level !== 'none')

  if (!reasoning || efforts.length === 0) {
    return { state: 'unavailable' }
  }

  return { defaultLevel: reasoning.defaultLevel, efforts, state: 'levels', thinkingToggle: reasoning.levels.includes('none') }
}

export function useManagedReasoning(model: string): ManagedReasoning | null {
  return managedReasoning(model, enforcedModels(useStore($managedModels)))
}

/**
 * The stock effort list a control offers, narrowed to the model's levels
 * (`values` may include `none`, as Settings' select does). Stock when not managed.
 */
export function managedEffortValues<T extends string>(model: string, values: readonly T[]): readonly T[] {
  const managed = managedReasoning(model)

  if (!managed || managed.state !== 'levels') {
    return values
  }

  return values.filter(value => (value === 'none' ? managed.thinkingToggle : managed.efforts.includes(value)))
}

// ── /reasoning ──────────────────────────────────────────────────────────────

const EFFORT_WORDS = new Set<string>([...REASONING_LADDER, 'false', 'disabled', 'off'])
const SCOPE_FLAGS = new Set(['--global', '-g', 'global', '--session', '-s', 'session'])

/**
 * What `/reasoning <arg>` answers instead of running, or null to run it.
 * The display words (`show`, `hide`, `full`, `clamp`) always run: they are about
 * the transcript, not the model.
 */
export function reasoningSlashRefusal(arg: string, model: string): null | string {
  const models = enforcedModels()

  if (!models) {
    return null
  }

  const words = arg
    .trim()
    .split(/\s+/)
    .filter(word => word && !SCOPE_FLAGS.has(word.toLowerCase()))

  const level = words.length === 1 && EFFORT_WORDS.has(words[0].toLowerCase()) ? normalizeEffort(words[0]) : null

  if (words.length > 0 && level === null) {
    return null
  }

  const managed = managedReasoning(model, models)

  if (managed?.state === 'off') {
    return REASONING_CONTROL_OFF
  }

  if (level === null || !managed) {
    return null
  }

  const label = findModelEntry(models, model)?.label ?? model

  if (managed.state === 'unavailable') {
    return level === 'none' ? null : `Reasoning effort: ${REASONING_UNAVAILABLE.toLowerCase()} (${label}).`
  }

  const offered = [...(managed.thinkingToggle ? ['none'] : []), ...managed.efforts]

  return offered.includes(level) ? null : `${level} isn't available for ${label}. Choose ${offered.join(', ')}.`
}
