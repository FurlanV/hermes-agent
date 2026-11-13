/**
 * Install the role's allowed models from the verified client config (F02 slice 20).
 *
 * The config's `models` section (`electron/athena/model-policy.ts` reads it)
 * becomes, under `managed.models: enforce`:
 * - the model-options selector's policy (`models.ts`): every picker lists the
 *   allowed models that are not hidden, in config order, on the model
 *   gateway's row; typed and remembered custom ids are gone; `/model <id>`
 *   outside the list answers "Not available for your role";
 * - the admin's labels (`model-labels.ts`) and notes (a `modelMenu.row` badge);
 * - a check on the JSON-RPC seam for the requests that pick a model.
 * Under `report` nothing is narrowed and each pick outside the list is recorded
 * (`athena:policy_decision`, kind `model`); under `off` the app is stock. The
 * model gateway enforces in every mode.
 *
 * A local model (a bridge model, F05 slice 05) is on the list only while local
 * models are on and main reports this laptop's HPC bridge up
 * (`snapshot.hpcBridge`); it is listed on the second provider's row, under the
 * name hermes knows it by, with the admin's label.
 *
 * A new `config_version`, or the bridge coming or going, also drops the cached
 * model options, so no picker keeps an hour-old catalog.
 */

import type { ModelOptionProvider } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'

import { MODEL_MENU_ROW_AREA, type ModelMenuRowContribution } from '@/app/shell/model-menu-row-decorations'
import { registry } from '@/contrib/registry'
import { queryClient } from '@/lib/query-client'

import {
  findModelEntry,
  isAllowedModel,
  isAthenaProvider,
  isModelSubcommand,
  type ManagedModels,
  managedModels,
  managedPickerRows,
  modelUseDecision,
  rpcModelChoice
} from '../../../electron/athena/model-policy'

import { $clientConfig, type ClientConfigSnapshot } from './client-config'

export { managedPickerRows }
import { setManagedModelLabels } from './model-labels'
import { ALLOW_ALL_MODELS, type ModelPolicy, setModelPolicy } from './models'
import { recordModelDecision } from './policy-decisions'

/** The `models` section for a snapshot, or null: no snapshot yet (no Electron bridge), or the stock variant. */
export const managedModelsForSnapshot = (snapshot: ClientConfigSnapshot | null): ManagedModels | null =>
  snapshot && snapshot.variant !== 'stock'
    ? managedModels(snapshot.config, { bridgeUp: Boolean(snapshot.hpcBridge) })
    : null

export const $managedModels = computed($clientConfig, managedModelsForSnapshot)

/** The managed list when it restricts (`managed.models: enforce`), else null. */
export const enforcedModels = (models: ManagedModels | null = $managedModels.get()): ManagedModels | null =>
  models?.mode === 'enforce' ? models : null

export function useManagedModels(): ManagedModels | null {
  return useStore($managedModels)
}

/** The selector policy for a managed list: restrictive under `enforce`, allow-all otherwise. */
export function modelPolicyFor(models: ManagedModels | null): ModelPolicy {
  const enforced = enforcedModels(models)

  if (!enforced) {
    return ALLOW_ALL_MODELS
  }

  // One cached result per catalog reference, so memoized pickers keep their rows.
  let lastCatalog: null | readonly ModelOptionProvider[] = null
  let lastRows: readonly ModelOptionProvider[] = []

  return {
    customIds: false,
    rows: catalog => {
      if (catalog !== lastCatalog) {
        lastCatalog = catalog
        lastRows = managedPickerRows(enforced, catalog)
      }

      return lastRows
    },
    selectable: choice => isModelSubcommand(choice.model) || isAllowedModel(enforced, choice)
  }
}

/**
 * The JSON-RPC seam's model check (composed into the feature policy): a request
 * that picks a model outside the list is refused under `enforce` and recorded
 * under `report`. Defence in depth: the pickers never offer such a model, and
 * hermes does not check the list on a switch (slice 08).
 */
export function modelRpcAllowed(
  models: ManagedModels | null,
  method: string,
  params: Readonly<Record<string, unknown>>
): boolean {
  const choice = models ? rpcModelChoice(method, params) : null

  if (!models || !choice) {
    return true
  }

  const decision = modelUseDecision(models, choice, 'rpc', method)
  recordModelDecision(decision.record)

  return decision.allowed
}

// A local model keeps its label while the bridge is down (it is off the list then): old sessions still name it.
const labelsFor = (models: ManagedModels | null): null | ReadonlyMap<string, string> =>
  models && models.mode !== 'off'
    ? new Map([...models.localModels.configured, ...models.entries].map(entry => [entry.id, entry.label]))
    : null

const NOTES_CONTRIBUTION_ID = 'athena-model-notes'

const notes: ModelMenuRowContribution = {
  decorate: ({ model, provider }) => {
    const enforced = enforcedModels()
    const note = enforced && isAthenaProvider(provider) ? findModelEntry(enforced, model)?.note : null

    return note ? { badge: note } : null
  }
}

/** Drop every cached model-options read: the next picker open reads the backend again. */
export function dropCachedModelOptions(): void {
  queryClient.removeQueries({ queryKey: ['model-options'], type: 'inactive' })
  void queryClient.invalidateQueries({ queryKey: ['model-options'] })
}

/** Follow `$clientConfig`; returns the uninstall (which restores the stock pickers). */
export function installModelPolicy(): () => void {
  const removeNotes = registry.register({
    area: MODEL_MENU_ROW_AREA,
    data: notes,
    id: NOTES_CONTRIBUTION_ID,
    source: 'athena'
  })

  let lastVersion: string | undefined

  const offModels = $managedModels.subscribe(models => {
    setModelPolicy(modelPolicyFor(models))
    setManagedModelLabels(labelsFor(models))
  })

  const offVersion = $clientConfig.subscribe(snapshot => {
    // The bridge coming or going changes what hermes offers too (managed scope pins its provider only while up).
    const version = snapshot ? `${snapshot.configVersion}:${snapshot.hpcBridge ? 'bridge' : ''}` : undefined

    if (lastVersion !== undefined && version !== lastVersion) {
      dropCachedModelOptions()
    }

    lastVersion = version
  })

  return () => {
    offModels()
    offVersion()
    removeNotes()
    setModelPolicy(null)
    setManagedModelLabels(null)
  }
}
