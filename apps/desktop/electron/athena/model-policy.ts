// Athena managed models (F02 slices 20, 21 and 23): the role's allowed models,
// read from the effective client config (`models`, plan section B) by Electron
// main (the Settings default over REST) and the renderer (every picker,
// `/model`, the JSON-RPC seam, the auto-switch, the reasoning controls).
//
// Pure data plus pure functions, no runtime imports but the registry's master
// switch reader.
//
// - `models.allowed` is in picker order; `hidden` entries (the dev `mock`
//   alias) may be called but are never listed.
// - Every entry names what serves it (`provider`, F05 slice 02): `gateway`,
//   the Model gateway, unless the config says otherwise. `MODEL_PROVIDERS`
//   maps that name to the hermes provider; an entry whose provider this build
//   does not know is not on the list.
// - A bridge model (`provider: bridge`, F05 slice 05) is a local model reached
//   through the HPC bridge, on hermes's second provider (`custom:athena-vllm`).
//   It is on the list only while local models are on (the config's
//   `local_models.enabled` AND feature row F05) and this laptop's bridge is up
//   (main reads the Profile's bridge record, hpc-bridge-record.ts). Hermes knows
//   it by the model server's name (`local_models.models.<id>.name`), not by the
//   config's id, so that name is the entry's `id` here: what pickers list, what
//   a pick sends and what a session reports. A bridge model is never the
//   default; a hidden or unnamed one is never offered (managed scope pins none).
// - `managed.models` (master switch): `enforce` lists and accepts only the
//   allowed models; `report` lists and accepts everything and records each pick
//   outside the list; `off` is stock. The model gateway enforces in every mode.
// - `models.reasoning_control` (`on` | `off`, default on): `off` turns the
//   reasoning-effort control off (under `enforce`).

import { featureStates, managedMode } from './feature-registry'

export const ATHENA_GATEWAY_PROVIDER = 'custom:athena-gateway'
/** The hermes provider bridge models are called on (athena's `local_models.BRIDGE_PROVIDER`). */
export const ATHENA_BRIDGE_PROVIDER = 'custom:athena-vllm'

/** A hermes provider that serves allowed models, and the name its picker row gets when the catalog has none. */
export interface ModelProviderInfo {
  name: string
  /** The hermes provider (`custom:<key>`). */
  slug: string
}

/** The client config's name for the provider of a model that names none: the Model gateway. */
export const DEFAULT_MODEL_PROVIDER = 'gateway'
/** The client config's name for the provider of a bridge model. */
export const BRIDGE_MODEL_PROVIDER = 'bridge'
/** The feature row that, with the config's `local_models.enabled`, turns local models on. */
export const LOCAL_MODELS_FEATURE = 'F05'

/** The hermes provider behind each `models.allowed[].provider` name of the client config. */
export const MODEL_PROVIDERS: Readonly<Record<string, ModelProviderInfo>> = Object.freeze({
  [DEFAULT_MODEL_PROVIDER]: { name: 'Athena gateway', slug: ATHENA_GATEWAY_PROVIDER },
  [BRIDGE_MODEL_PROVIDER]: { name: 'Local models', slug: ATHENA_BRIDGE_PROVIDER }
})

/** Hermes's reasoning ladder (`hermes_constants.VALID_REASONING_EFFORTS` plus `none`), weakest first. */
export const REASONING_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** `/model` words hermes reads as subcommands, not model ids (`hermes_cli/model_switch.py`). */
const MODEL_SUBCOMMANDS = new Set(['reset'])

export type ManagedModelsMode = 'enforce' | 'off' | 'report'

export interface ManagedModelEntry {
  /** The model's id in the client config (`models.allowed[].id`). Differs from `id` for a bridge model only. */
  configId: string
  /** The reasoning level selected when the model is picked (one of `levels`). */
  defaultLevel: string
  hidden: boolean
  /**
   * The name hermes knows the model by: what pickers list, a pick sends and a session reports. The config's id
   * for a Model gateway model; the model server's own name for a bridge model.
   */
  id: string
  label: string
  /** The efforts users may pick for this model, in ladder order as the config lists them. */
  levels: readonly string[]
  note: null | string
  /** The hermes provider that serves the model (`custom:athena-gateway` unless the config names another). */
  provider: string
}

/** Local models (F05): the bridge models of the config, and whether they are offered now. */
export interface LocalModels {
  /** This laptop's HPC bridge is up (a live bridge record). */
  bridgeUp: boolean
  /** The bridge models the config offers (named, not hidden), whether or not they are on the list now. */
  configured: readonly ManagedModelEntry[]
  /** The config's `local_models.enabled` and feature row F05 are both on. */
  on: boolean
}

/** What `managedModels` needs to know beside the config. */
export interface ManagedModelsState {
  /** True while main holds a live bridge record for this Profile (default false). */
  bridgeUp?: boolean
}

export interface ManagedModels {
  /** The role default (null when the config names none that is allowed). Never a bridge model while another is listed. */
  default: null | string
  /** Every allowed entry, hidden ones included, in config order. Bridge models only while they can be called. */
  entries: readonly ManagedModelEntry[]
  localModels: LocalModels
  mode: ManagedModelsMode
  /** `models.reasoning_control` (default on). */
  reasoningControl: boolean
  /** What pickers list: the entries that are not hidden. */
  visible: readonly ManagedModelEntry[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const LADDER = new Set<string>(REASONING_LADDER)

function parseEntry(raw: unknown, serverNames: Record<string, unknown>): ManagedModelEntry | null {
  if (!isRecord(raw) || !text(raw.id)) {
    return null
  }

  const configId = text(raw.id)
  const providerName = text(raw.provider) || DEFAULT_MODEL_PROVIDER
  const provider = MODEL_PROVIDERS[providerName]

  // A provider this build has no route for (a newer server's): the model is not on the list.
  if (!provider) {
    return null
  }

  let id = configId

  if (providerName === BRIDGE_MODEL_PROVIDER) {
    const named = serverNames[configId]
    id = isRecord(named) ? text(named.name) : ''

    // Managed scope pins no hidden bridge model and none the config does not name: hermes could not call it.
    if (!id || raw.hidden === true) {
      return null
    }
  }

  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : {}

  const levels = Array.isArray(reasoning.levels)
    ? [...new Set(reasoning.levels.map(text).filter(level => LADDER.has(level)))]
    : []

  const safeLevels = levels.length ? levels : ['none']
  const wanted = text(reasoning.default)

  return {
    configId,
    defaultLevel: safeLevels.includes(wanted) ? wanted : safeLevels[0],
    hidden: raw.hidden === true,
    id,
    label: text(raw.label) || configId,
    levels: safeLevels,
    note: text(raw.note) || null,
    provider: provider.slug
  }
}

export const isBridgeModel = (entry: Pick<ManagedModelEntry, 'provider'>): boolean =>
  entry.provider === ATHENA_BRIDGE_PROVIDER

/** Whether a config turns local models on: its own switch (`local_models.enabled`) and feature row F05. */
export function localModelsOn(config: unknown): boolean {
  const section = isRecord(config) && isRecord(config.local_models) ? config.local_models : {}

  return section.enabled === true && featureStates(config).flag(LOCAL_MODELS_FEATURE)
}

/**
 * The `models` section of an effective client config, read tolerantly (main already verified it). Bridge models
 * are on the list only while local models are on and `state.bridgeUp` says this laptop's bridge is open.
 */
export function managedModels(config: unknown, state: ManagedModelsState = {}): ManagedModels {
  const models = isRecord(config) && isRecord(config.models) ? config.models : {}
  const local = isRecord(config) && isRecord(config.local_models) ? config.local_models : {}
  const serverNames = isRecord(local.models) ? local.models : {}
  const on = localModelsOn(config)
  const bridgeUp = state.bridgeUp === true
  const seen = new Set<string>()
  const seenConfigIds = new Set<string>()
  const entries: ManagedModelEntry[] = []
  const configured: ManagedModelEntry[] = []

  for (const raw of Array.isArray(models.allowed) ? models.allowed : []) {
    const entry = parseEntry(raw, serverNames)

    if (!entry || seen.has(entry.id) || seenConfigIds.has(entry.configId)) {
      continue
    }

    if (isBridgeModel(entry)) {
      configured.push(entry)

      if (!on || !bridgeUp) {
        continue
      }
    }

    seen.add(entry.id)
    seenConfigIds.add(entry.configId)
    entries.push(entry)
  }

  const wantedDefault = text(models.default)
  const visible = entries.filter(entry => !entry.hidden)
  // A bridge model answers only while this laptop's bridge is up: never the default (the server refuses one too).
  const defaultEntry = entries.find(entry => entry.configId === wantedDefault && !isBridgeModel(entry))

  return {
    default: defaultEntry?.id ?? (visible.find(entry => !isBridgeModel(entry)) ?? visible[0])?.id ?? null,
    entries,
    localModels: { bridgeUp, configured, on },
    mode: managedMode(config, 'models'),
    reasoningControl: models.reasoning_control !== 'off',
    visible
  }
}

/** The provider key without `custom:` (`custom:athena-gateway` → `athena-gateway`). */
const providerKey = (provider: string): string =>
  provider
    .trim()
    .toLowerCase()
    .replace(/^custom:/, '')

/** Whether two hermes provider names are the same provider (`custom:` and case aside). */
export const sameProvider = (a: string, b: string): boolean => providerKey(a) === providerKey(b)

export const isGatewayProvider = (provider: string): boolean => sameProvider(provider, ATHENA_GATEWAY_PROVIDER)

/** The Athena providers a Profile configures: the Model gateway and the bridge's (`athena-vllm`). */
export const isAthenaProvider = (provider: string): boolean =>
  Object.values(MODEL_PROVIDERS).some(known => sameProvider(provider, known.slug))

export const isModelSubcommand = (model: string): boolean => MODEL_SUBCOMMANDS.has(model.trim().toLowerCase())

export interface ModelChoice {
  model: string
  /** Absent when the caller has no provider (a bare `/model <id>`). */
  provider?: string
}

export const findModelEntry = (models: ManagedModels, id: string): ManagedModelEntry | undefined =>
  models.entries.find(entry => entry.id === id.trim())

/**
 * Whether a model is on the role's list: an allowed id (hidden ones too: they
 * stay callable), on the provider its own entry names when a provider is named
 * (a gateway model on the bridge's provider is refused, and the reverse).
 * Ignores the master switch; `modelUseDecision` applies it.
 */
export function isAllowedModel(models: ManagedModels, choice: ModelChoice): boolean {
  const entry = findModelEntry(models, choice.model)

  if (!entry) {
    return false
  }

  return choice.provider === undefined || !choice.provider.trim() || sameProvider(choice.provider, entry.provider)
}

/** What a model use records (Electron main stamps `ts` and `source`; `kind` is `model`). */
export interface ModelDecisionRecord {
  action: 'allowed_in_report' | 'refused'
  /** The model alias asked for. */
  id: string
  mode: ManagedModelsMode
  /** `picker`, `slash`, `rpc`, `rest`, … */
  surface: string
  target: string
}

export interface ModelDecision {
  allowed: boolean
  record: ModelDecisionRecord | null
}

/**
 * Decide one model use (a pick, `/model <id>`, a default write) under the master switch:
 * - `enforce`: refused unless allowed, and the refusal recorded;
 * - `report`: allowed, and a pick outside the list recorded as `allowed_in_report`;
 * - `off`: allowed, nothing recorded.
 * `/model reset` and the other subcommand words always pass: they name no model.
 */
export function modelUseDecision(
  models: ManagedModels,
  choice: ModelChoice,
  surface: string,
  target: string
): ModelDecision {
  if (models.mode === 'off' || isModelSubcommand(choice.model) || isAllowedModel(models, choice)) {
    return { allowed: true, record: null }
  }

  const id = choice.model.trim()

  return models.mode === 'report'
    ? { allowed: true, record: { action: 'allowed_in_report', id, mode: 'report', surface, target } }
    : { allowed: false, record: { action: 'refused', id, mode: 'enforce', surface, target } }
}

/** The first token of a `config.set key=model` value (`<model> --provider <p> [--session]`), with its provider. */
export function configSetModelChoice(value: unknown): ModelChoice | null {
  const tokens = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const model = tokens[0]

  if (!model || model.startsWith('-')) {
    return null
  }

  const at = tokens.indexOf('--provider')
  const provider = at >= 0 ? tokens[at + 1] : undefined

  return provider && !provider.startsWith('-') ? { model, provider } : { model }
}

/**
 * `/model <id> [--provider <slug>] [--session]` (and `/model` flags in any
 * order): the choice it asks for, or null when it names no model.
 */
export function slashModelChoice(arg: string): ModelChoice | null {
  const tokens = arg.trim().split(/\s+/).filter(Boolean)
  const valueFlags = new Set(['--provider', '--reasoning'])
  const model = tokens.find((token, index) => !token.startsWith('-') && !valueFlags.has(tokens[index - 1] ?? ''))

  if (!model) {
    return null
  }

  const at = tokens.indexOf('--provider')
  const provider = at >= 0 ? tokens[at + 1] : undefined

  return provider && !provider.startsWith('-') ? { model, provider } : { model }
}

/** The `--reasoning <level>` a `/model` argument asks for, or null. */
export function slashModelReasoning(arg: string): null | string {
  const tokens = arg.trim().split(/\s+/).filter(Boolean)
  const at = tokens.indexOf('--reasoning')
  const level = at >= 0 ? tokens[at + 1] : undefined

  return level && !level.startsWith('-') ? level.toLowerCase() : null
}

/**
 * The model a JSON-RPC request picks, or null when it picks none:
 * `config.set key=model` (every picker), `slash.exec` / `command.dispatch` of
 * `/model <id>`, and `session.model` (a confirmed pick).
 */
export function rpcModelChoice(method: string, params: Readonly<Record<string, unknown>>): ModelChoice | null {
  if (method === 'config.set') {
    return params.key === 'model' ? configSetModelChoice(params.value) : null
  }

  if (method === 'slash.exec') {
    const [name, ...rest] = text(params.command).replace(/^\/+/, '').split(/\s+/)

    return name?.toLowerCase() === 'model' ? slashModelChoice(rest.join(' ')) : null
  }

  if (method === 'command.dispatch') {
    const name = text(params.name).replace(/^\/+/, '').toLowerCase()

    return name === 'model' ? slashModelChoice(text(params.arg)) : null
  }

  if (method === 'session.model') {
    const model = text(params.model)
    const provider = text(params.provider)

    return model ? (provider ? { model, provider } : { model }) : null
  }

  return null
}

/** The main model a `POST /api/model/set` body writes (Settings › Model), or null for other scopes. */
export function restModelChoice(method: string, pathname: string, body: unknown): ModelChoice | null {
  if (method.toUpperCase() !== 'POST' || pathname !== '/api/model/set' || !isRecord(body)) {
    return null
  }

  const scope = text(body.scope)
  const model = text(body.model)
  const provider = text(body.provider)

  if ((scope && scope !== 'main') || !model) {
    return null
  }

  return provider ? { model, provider } : { model }
}

/** The fields of a `model.options` provider row (`ModelOptionProvider`) the managed rows read and write. */
export interface PickerRow {
  aliases?: null | string[]
  featured_models?: null | string[]
  models?: string[]
  slug: string
  total_models?: null | number
}

/** The catalog row of a hermes provider, matched by slug or alias. */
const providerRow = <T extends PickerRow>(catalog: readonly T[], provider: string): T | undefined =>
  catalog.find(
    row => sameProvider(row.slug, provider) || (row.aliases ?? []).some(alias => sameProvider(alias, provider))
  )

const madeRow = (provider: string): PickerRow & Record<string, unknown> => ({
  authenticated: true,
  name: Object.values(MODEL_PROVIDERS).find(known => sameProvider(known.slug, provider))?.name ?? provider,
  slug: provider
})

/**
 * The picker rows under the managed list: one row per provider that serves a
 * visible allowed model (the Model gateway's, and the bridge's `athena-vllm`
 * while a local model is on the list), carrying exactly that provider's
 * visible ids in config order (from the config, not the backend's cached
 * discovery, so an admin change shows within one poll). Every other provider,
 * and every other model of those two, is dropped. Without a provider's row in
 * the catalog (not loaded yet, or a Profile without it) one is made up, so the
 * list still shows.
 */
export function managedPickerRows<T extends PickerRow>(models: ManagedModels, catalog: readonly T[]): T[] {
  if (models.visible.length === 0) {
    return []
  }

  const rows: T[] = []

  for (const provider of new Set(models.visible.map(entry => entry.provider))) {
    const ids = models.visible.filter(entry => entry.provider === provider).map(entry => entry.id)
    const found = providerRow(catalog, provider)

    rows.push({
      ...(found ?? (madeRow(provider) as PickerRow as T)),
      featured_models: ids,
      models: ids,
      total_models: ids.length
    })
  }

  return rows
}

// ── Reasoning effort (slice 23) ─────────────────────────────────────────────

export interface ModelReasoning {
  defaultLevel: string
  levels: readonly string[]
}

/** The reasoning levels a model offers under the config, or null when the config says nothing (stock control). */
export function modelReasoning(models: ManagedModels, model: string): ModelReasoning | null {
  const entry = findModelEntry(models, model)

  return entry ? { defaultLevel: entry.defaultLevel, levels: entry.levels } : null
}

/** True when a model's only level is `none`: the control shows "Not available for this model yet". */
export const reasoningUnavailable = (reasoning: ModelReasoning | null): boolean =>
  reasoning !== null && reasoning.levels.every(level => level === 'none')

/** Normalize a hermes effort word (`false`/`disabled`/`off` are `none`). */
export function normalizeEffort(effort: string): string {
  const value = effort.trim().toLowerCase()

  return value === 'false' || value === 'disabled' || value === 'off' ? 'none' : value
}

/**
 * The level to keep after switching to a model: the current one when the
 * model offers it, else the model's default. An empty current level (inherit)
 * resolves to the model's default too: what hermes would send for "inherit"
 * is not knowable here, and it may be a level the model does not offer.
 */
export function levelAfterSwitch(reasoning: ModelReasoning, current: string): string {
  const level = normalizeEffort(current)

  return level && reasoning.levels.includes(level) ? level : reasoning.defaultLevel
}
