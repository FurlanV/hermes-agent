/**
 * The one model-options selector every model picker reads (F02).
 *
 * The composer model menu, the model picker dialog, Edit Models, the Settings
 * model selects and `/model <id>` all get their rows and their "may this id be
 * picked?" answer here:
 * - `modelPickerProviders`: catalog rows with the remembered custom ids
 *   (`hermes.desktop.custom-models`) merged in, narrowed by `isModelSelectable`;
 * - `modelPickerCustomCandidate`: the typed id a picker offers as its own row;
 * - `allowsCustomModelIds`: whether the "Add custom model…" / "Custom model…"
 *   entries are offered at all;
 * - `isModelSelectable`: the single check.
 *
 * With no client config (or `managed.models` off / report) the policy allows
 * every model and typed ids, so every picker shows exactly what it did before.
 * Under `enforce`, `model-policy.ts` installs the role's allowed models with
 * `setModelPolicy` (slice 20): `rows` replaces the catalog with the allowed
 * list, in config order, and every picker narrows at once.
 */

import type { ModelOptionProvider } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

import { type CustomModel, customModelCandidate, withCustomModels } from '@/store/custom-models'

import { type ModelChoice, slashModelChoice } from '../../../electron/athena/model-policy'

export type { ModelChoice }

export interface ModelPolicy {
  /** False hides "Add custom model…", typed-id rows and ignores remembered custom ids. */
  customIds: boolean
  /**
   * When set, the rows every picker lists, built from the catalog (the managed
   * list: the role's allowed models in config order). Replaces the narrowing by
   * `selectable`; remembered custom ids are not merged.
   */
  rows?: (catalog: readonly ModelOptionProvider[]) => readonly ModelOptionProvider[]
  selectable: (choice: ModelChoice) => boolean
}

export const ALLOW_ALL_MODELS: ModelPolicy = Object.freeze({ customIds: true, selectable: () => true })

export const $modelPolicy = atom<ModelPolicy>(ALLOW_ALL_MODELS)

/** Install a policy (`null` restores allow-everything). */
export function setModelPolicy(policy: null | ModelPolicy): void {
  $modelPolicy.set(policy ?? ALLOW_ALL_MODELS)
}

/** The single check: may this model be selected (picked, typed, or sent by `/model`)? */
export function isModelSelectable(choice: ModelChoice, policy: ModelPolicy = $modelPolicy.get()): boolean {
  return policy.selectable(choice)
}

export function allowsCustomModelIds(policy: ModelPolicy = $modelPolicy.get()): boolean {
  return policy.customIds
}

/**
 * The provider rows every picker lists: the catalog, plus remembered custom
 * ids, minus models the policy refuses. Returns `catalog` itself when nothing
 * changes, so memoized consumers keep their reference.
 */
export function modelPickerProviders(
  catalog: readonly ModelOptionProvider[],
  customs: readonly CustomModel[],
  policy: ModelPolicy = $modelPolicy.get()
): readonly ModelOptionProvider[] {
  if (policy.rows) {
    return policy.rows(catalog)
  }

  const merged = policy.customIds ? withCustomModels(catalog, customs) : catalog

  if (policy === ALLOW_ALL_MODELS) {
    return merged
  }

  let changed = false

  const narrowed = merged.map(provider => {
    const models = provider.models ?? []
    const kept = models.filter(model => policy.selectable({ model, provider: provider.slug }))

    if (kept.length === models.length) {
      return provider
    }

    changed = true

    return { ...provider, models: kept }
  })

  return changed ? narrowed : merged
}

/** The typed id a picker offers as a row of its own, or null (no candidate, or not allowed). */
export function modelPickerCustomCandidate(
  search: string,
  providers: readonly ModelOptionProvider[],
  policy: ModelPolicy = $modelPolicy.get()
): null | string {
  if (!policy.customIds) {
    return null
  }

  const slug = customModelCandidate(search, providers)

  return slug && policy.selectable({ model: slug }) ? slug : null
}

/**
 * `/model <id> [--provider <slug>] [--session]`: the choice it asks for, or
 * null when the argument names no model (the backend answers that itself).
 * Words the backend treats as subcommands (`/model reset`) come back as a
 * model too; a policy that narrows models lets them through
 * (`isModelSubcommand`).
 */
export const modelSlashChoice = (arg: string): ModelChoice | null => slashModelChoice(arg)

/** What `/model <id>` says when the policy refuses the id (slice 20). */
export const modelNotSelectableMessage = (model: string): string => `${model}: Not available for your role.`

/** Subscribe a component to policy changes; pass the result to the selector and into memo deps. */
export function useModelPolicy(): ModelPolicy {
  return useStore($modelPolicy)
}
