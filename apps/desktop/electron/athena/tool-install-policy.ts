// Athena: every way to add a skill, plugin, connector or MCP server, refused under `managed.tools` (F02 slice 29).
//
// Pure, no imports beyond the registry and the feature decider, shared by Electron main (REST, IPC, deep links)
// and the renderer (JSON-RPC, the install dialogs, the desktop-plugin loader). It is not a feature row: install
// paths follow the tools master switch (plan section D, layer 4), not a per-role flag, so an admin who turns a
// feature row on (Bot Mode S123, say) does not reopen the installs it would offer.
//
// `managedMode(config, 'tools')`:
// - `enforce`: a call reaching an entry below is refused, and the refusal recorded (`kind: "tool"`);
// - `report`: it goes through, and the use is recorded as `allowed_in_report`;
// - `off`: stock behaviour, nothing recorded.
//
// Entries use the backend-policy ids (`rest:`, `rpc:<method>/<action>`, `ipc:`, `deep-link:<kind>`) plus two
// renderer-only kinds: `ui:<dialog>` (an install dialog or lookup the renderer opens) and `desktop-plugin:<folder>`
// (a disk plugin not on the build's allowlist, src/athena/managed/desktop-plugin-gate.ts). In a pattern, a
// trailing `*` is any rest and `{}` is exactly one path segment.
//
// Left open on purpose (managed scope pins the result, plan section D layer 1): `PUT /api/config` (Settings saves
// send whole sections, so a key filter would refuse ordinary saves), `plugins.manage toggle` / `PUT
// /api/skills/toggle` (enable something already installed; `plugins.enabled` and `skills.disabled` are pinned),
// `mcp.servers.test`/`set_api_key`/`oauth.*` and `hermes:mcp-oauth:*` (act on configured servers only),
// `skills.manage list`, `GET /api/mcp/catalog`, and profile import, which S122 governs.

import { type FeatureDecider, featureDecider, type FeatureDecision } from './backend-policy'
import { managedMode } from './feature-registry'

export interface ToolInstallRow {
  entries: readonly string[]
  /** Recorded as the decision's `id` (`kind: "tool"`). */
  id: string
  title: string
}

const row = (id: string, title: string, entries: readonly string[]): ToolInstallRow =>
  Object.freeze({ entries: Object.freeze([...entries]), id, title })

const actions = (method: string, ...names: string[]) => names.map(name => `rpc:${method}/${name}`)

export const TOOL_INSTALL_ROWS: readonly ToolInstallRow[] = Object.freeze([
  row('install:skill-hub', 'Skills hub: browse, search, preview, scan, install, update, uninstall', [
    'rest:/api/skills/hub/*',
    ...actions('skills.manage', 'install', 'search', 'browse', 'inspect'),
    'deep-link:skill',
    'ui:skill-install'
  ]),
  row('install:skill-write', 'Write a skill by hand (create, replace its content)', [
    'rest:POST /api/skills',
    'rest:PUT /api/skills/content'
  ]),
  row('install:plugin', 'Agent plugins: install from git or the catalog, inspect, update, remove', [
    ...actions('plugins.manage', 'install', 'inspect', 'update', 'update_all', 'auto_update', 'remove'),
    'rpc:plugins.catalog.lookup',
    'deep-link:plugin',
    'deep-link:plugin-agent',
    'deep-link:install',
    'ui:plugin-install',
    'ui:plugin-catalog-lookup'
  ]),
  row('install:desktop-plugin', 'Desktop plugins: probe, install, remove, and any plugin.js not in the build', [
    ...actions('plugins.manage', 'install_desktop', 'remove_desktop'),
    'ipc:hermes:plugin:probe',
    'ipc:hermes:plugin:installDesktop',
    'ipc:hermes:plugin:removeDesktop',
    'deep-link:plugin-desktop',
    'desktop-plugin:*'
  ]),
  row('install:mcp-server', 'MCP servers: add, replace (mcp.json), remove, enable, catalog install', [
    'rest:POST /api/mcp/servers',
    'rest:PUT /api/mcp/servers',
    'rest:PUT /api/mcp/servers/{}/enabled',
    'rest:DELETE /api/mcp/servers/{}',
    'rest:/api/mcp/catalog/install',
    'rpc:mcp.servers.add',
    'rpc:mcp.servers.remove',
    'deep-link:mcp',
    'ui:mcp-install'
  ]),
  row('install:connector', 'Hosted connectors (connectors.*) and their browser return link', [
    'rpc:connectors.*',
    'deep-link:connections'
  ]),
  row('install:raw-config', 'The raw config.yaml editor (replaces the whole file)', ['rest:WRITE /api/config/raw']),
  row('install:toolsets', 'Toolsets: enable or disable one, run its post-setup installer', [
    'rest:PUT /api/tools/toolsets/{}',
    'rest:POST /api/tools/toolsets/{}/post-setup',
    'rpc:tools.configure'
  ])
])

const escape = (text: string) => text.replace(/[.+?^$()|[\]\\]/g, '\\$&')

function compile(pattern: string): RegExp {
  const prefix = pattern.endsWith('*')
  const body = (prefix ? pattern.slice(0, -1) : pattern).split('{}').map(escape).join('[^/]+')

  return new RegExp(`^${body.replace(/\*/g, '\\*')}${prefix ? '' : '$'}`)
}

const MATCHERS: readonly (readonly [RegExp, ToolInstallRow])[] = TOOL_INSTALL_ROWS.flatMap(r =>
  r.entries.map(entry => [compile(entry), r] as const)
)

/** The install row an entry id reaches, or null. */
export function toolInstallRowFor(entry: string): null | ToolInstallRow {
  return MATCHERS.find(([matcher]) => matcher.test(entry))?.[1] ?? null
}

/** Whether an IPC channel is an install channel (tracked by the IPC guard so it follows `managed.tools`). */
export const isToolInstallIpcChannel = (channel: string): boolean => toolInstallRowFor(`ipc:${channel}`) !== null

const ALLOWED: FeatureDecision = Object.freeze({ allowed: true, record: null })

/** Decide calls under the tools master switch (see the header). */
export function toolInstallDecider(config: unknown): FeatureDecider {
  const mode = managedMode(config, 'tools')

  if (mode === 'off') {
    return () => ALLOWED
  }

  return (entries, surface, target) => {
    for (const entry of entries) {
      const hit = toolInstallRowFor(entry)

      if (hit) {
        const enforce = mode === 'enforce'

        return {
          allowed: !enforce,
          record: { action: enforce ? 'refused' : 'allowed_in_report', id: hit.id, kind: 'tool', mode, surface, target }
        }
      }
    }

    return ALLOWED
  }
}

/**
 * The one decider every backend surface asks: the feature rows (`managed.features`), then the install paths
 * (`managed.tools`). A refusal from either wins; otherwise the first report-mode record is kept.
 */
export function backendDecider(config: unknown): FeatureDecider {
  const features = featureDecider(config)
  const tools = toolInstallDecider(config)

  return (entries, surface, target) => {
    const feature = features(entries, surface, target)

    if (!feature.allowed) {
      return feature
    }

    const tool = tools(entries, surface, target)

    return tool.allowed ? { allowed: true, record: feature.record ?? tool.record } : tool
  }
}
