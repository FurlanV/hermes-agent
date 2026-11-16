// Athena: what the Profile's hermes managed scope declares about the Model gateway's models (F13 slice 18).
//
// athena's applier (`athena config apply`, run by the Shipper after each sync) writes managed scope to
// `$HERMES_HOME/athena/managed/config.yaml`, the folder the launcher hands the Desktop (and the gateway daemon it
// starts) as `HERMES_MANAGED_DIR`. The Shipper stores the new signed config first and rewrites managed scope after
// its catalog and package syncs, so for a moment the Desktop sees a model hermes would refuse: a switch on the
// gateway's `codex_responses` provider passes only for a model the provider declares (docs/hermes-findings.md 9.1).
//
// Main reads the file with the client config's other inputs, every second, into each snapshot (`managedScope`):
// - the ids declared on `providers.athena-gateway.models` and `providers.athena-gateway-chat.models`, the keys of
//   hermes's dict shape or the items of an older applier's list;
// - `model.default`, the model hermes starts a session on.
// A file that is missing, cannot be parsed, or is not a mapping gives nothing (`null`): hermes fails open on such a
// file too, and the pickers fall back to the client config's list.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { ManagedScopeModels } from './client-config-types'
import { ATHENA_GATEWAY_CHAT_PROVIDER, ATHENA_GATEWAY_PROVIDER } from './model-policy'

export const MANAGED_DIR_ENV = 'HERMES_MANAGED_DIR'
export const MANAGED_CONFIG_FILE = 'config.yaml'

/** The `providers` keys of the Model gateway's two hermes providers (`custom:athena-gateway` → `athena-gateway`). */
const GATEWAY_PROVIDER_KEYS = [ATHENA_GATEWAY_PROVIDER, ATHENA_GATEWAY_CHAT_PROVIDER].map(slug =>
  slug.replace(/^custom:/, '')
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The managed-scope folder hermes reads: `HERMES_MANAGED_DIR` when set, else the Profile's (athena's `managed_dir_for`). */
export function managedDirFor(athenaDir: string, env: Readonly<Record<string, string | undefined>>): string {
  return env[MANAGED_DIR_ENV]?.trim() || path.join(athenaDir, 'managed')
}

/** The ids a provider entry's `models` declares: a dict's keys, or a list's string items. */
function declaredIds(models: unknown): string[] {
  const ids = Array.isArray(models) ? models : isRecord(models) ? Object.keys(models) : []

  return ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
}

/** What a parsed managed `config.yaml` declares about the gateway's models, or null for a document that is not one. */
export function managedScopeModels(doc: unknown): ManagedScopeModels | null {
  if (!isRecord(doc)) {
    return null
  }

  const providers = isRecord(doc.providers) ? doc.providers : {}
  const declared: Record<string, string[]> = {}

  for (const key of GATEWAY_PROVIDER_KEYS) {
    const entry = providers[key]

    if (isRecord(entry)) {
      declared[key] = declaredIds(entry.models)
    }
  }

  const model = isRecord(doc.model) ? doc.model.default : undefined

  return { declared, default: typeof model === 'string' && model.trim() ? model.trim() : null }
}

/** Read `<managedDir>/config.yaml` (null when it is missing or cannot be parsed). */
export function readManagedScopeModels(managedDir: string): ManagedScopeModels | null {
  try {
    return managedScopeModels(parseYaml(readFileSync(path.join(managedDir, MANAGED_CONFIG_FILE), 'utf8')))
  } catch {
    return null
  }
}
