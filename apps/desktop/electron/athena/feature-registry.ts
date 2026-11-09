// Athena feature registry (F02 slice 15): one row per line of the plan's
// feature audit (overview.md, section A, S01–S124 with the a/b splits), each
// with its mark, its build default and every entry id that reaches it.
//
// Pure data plus pure functions, no imports: Electron main (deep links, IPC)
// and the renderer (Settings, palette, shortcuts…) read the same table.
//
// Marks and build defaults (plan, "Marks" and "Flags and master switches"):
// - keep    → on by default; an admin can turn it off per role;
// - disable → off by default; an admin (client config `features`) or a
//             developer (dev override) can turn it on;
// - remove  → no flag: always off here, refused by the admin API. Slice 18
//             leaves them out of the build entirely.
//
// Entry ids (what a surface asks the filter about):
// - `settings:<view>`, `settings:<view>/<page>`: Settings pages, subpages and
//   sub-views (nav, palette, search targets, the route guard);
// - `config-field:<dotted key>`: config-schema field rows (page and search);
// - `setting:<view>.<kebab>`: hand-built Settings rows (search, and the row
//   itself through its `setting-field-<id>` DOM id);
// - `credential:<ENV_KEY>`: env-credential rows (search, and the row through
//   its `credential-key-<KEY>` DOM id);
// - `settings-control:<name>`: an in-page control with an explicit Athena gate.
// An id ending in `*` covers every id with that prefix (the longest match
// wins; an exact id beats any prefix). `*` anywhere else is literal.
//
// An entry listed under several rows stays reachable while any of them is on
// (a page holding a keep row and a disable row stays; it vanishes only when
// every row on it is off). An entry no row lists is not audited and is left
// alone.

export type FeatureMark = 'disable' | 'keep' | 'remove'
export type FeatureFlag = 'off' | 'on'
export type FeatureMode = 'enforce' | 'off' | 'report'

export interface FeatureRow {
  /** Where the audit lists it ("Model", "Surfaces outside Settings", …). */
  area: string
  entries: readonly string[]
  id: string
  mark: FeatureMark
  title: string
}

const row = (id: string, mark: FeatureMark, area: string, title: string, entries: readonly string[] = []): FeatureRow =>
  Object.freeze({ id, mark, area, title, entries: Object.freeze([...entries]) })

const cf = (...keys: string[]) => keys.map(key => `config-field:${key}`)
const st = (view: string, ...keys: string[]) => keys.map(key => `setting:${view}.${key}`)
const cred = (...keys: string[]) => keys.map(key => `credential:${key}`)

// Containers: pages and subpages holding several rows. Listed under each row on them (any on → reachable).
const MODEL_MAIN = 'settings:config:model/main'
const MODEL_DELEGATION = 'settings:config:model/delegation'
const APPEARANCE_GENERAL = 'settings:config:appearance/general'
const APPEARANCE_TYPOGRAPHY = 'settings:config:appearance/typography'
const APPEARANCE_LAYOUT = 'settings:config:appearance/window-layout'
const APPEARANCE_DISPLAY = 'settings:config:appearance/chat-display'
const WORKSPACE_PROJECTS = 'settings:config:workspace/projects'
const WORKSPACE_SHELL = 'settings:config:workspace/shell'
const SAFETY_APPROVALS = 'settings:config:safety/approvals'
const SAFETY_PRIVACY = 'settings:config:safety/privacy'
const BROWSER = 'settings:config:browser'
const VAULT = 'settings:vault'
const MEMORY_PERSISTENT = 'settings:config:memory/persistent'
const VOICE = 'settings:config:voice'
const VOICE_CONVERSATION = 'settings:config:voice/conversation'
const VOICE_SPEECH = 'settings:config:voice/speech'
const ADVANCED_DESKTOP = 'settings:config:advanced/desktop'
const ADVANCED_RUNTIME = 'settings:config:advanced/runtime'
const ADVANCED_TOOLS = 'settings:config:advanced/tools'
const ADVANCED_OUTPUT = 'settings:config:advanced/output'
const NOTIFICATIONS = 'settings:notifications'
const PROVIDERS = 'settings:providers'
const GATEWAY = 'settings:gateway'
const GATEWAY_CONNECTION = 'settings:gateway/connection'
const GATEWAY_MODE = 'setting:gateway.connection-mode'
const KEYS = 'settings:keys'
const KEYS_TOOLS = 'settings:keys/tools'
const KEYS_SETTINGS = 'settings:keys/settings'
const SESSIONS_ARCHIVED = 'settings:sessions/archived'
const ABOUT_UPDATES = 'settings:about/updates'

export const FEATURE_ROWS: readonly FeatureRow[] = Object.freeze([
  // ── Every Settings page ──
  row('S01', 'disable', 'Every Settings page', 'Export config', ['settings-control:export-config']),
  row('S02', 'disable', 'Every Settings page', 'Import config', ['settings-control:import-config']),
  row('S03', 'disable', 'Every Settings page', 'Reset to defaults', ['settings-control:reset-config']),
  row('S04', 'disable', 'Every Settings page', '"Applies to" profile chips', ['settings-control:profile-scope']),

  // ── Model ──
  row('S05', 'disable', 'Model', 'Main model › Provider', [MODEL_MAIN, 'settings-control:main-provider']),
  row('S06', 'keep', 'Model', 'Main model › Model', [MODEL_MAIN]),
  row('S07', 'remove', 'Model', 'Main model › Set up provider / API key', [MODEL_MAIN]),
  row('S08a', 'keep', 'Model', 'Reasoning effort', [MODEL_MAIN]),
  row('S08b', 'disable', 'Model', 'Speed / Fast (service tier)', [MODEL_MAIN, 'settings-control:main-speed']),
  row('S09', 'disable', 'Model', 'Context window override', [MODEL_MAIN, ...cf('model_context_length')]),
  row('S10', 'disable', 'Model', 'Fallback models', ['settings:config:model/fallbacks', ...cf('fallback_providers')]),
  row('S11', 'disable', 'Model', 'Auxiliary models', ['settings:config:model/auxiliary']),
  row('S12', 'disable', 'Model', 'Mixture of Agents', ['settings:config:model/moa', ...cf('moa.*')]),
  row('S13', 'disable', 'Model', 'Subagents › Routing', [MODEL_DELEGATION, 'settings-control:delegation-routing']),
  row('S14', 'remove', 'Model', 'Subagents › "Install plugin" (Advanced Delegation)', [
    'settings-control:delegation-install-plugin'
  ]),
  row('S15', 'disable', 'Model', 'Subagents › model, provider, limits, timeout, effort', [
    MODEL_DELEGATION,
    ...cf('delegation.*')
  ]),
  row('S16', 'keep', 'Model', 'Restart backend (shown on version skew)', [MODEL_MAIN]),

  // ── Chat ──
  row('S17', 'keep', 'Chat', 'Personality', cf('display.personality')),
  row('S18', 'keep', 'Chat', 'Timezone', cf('timezone')),
  row('S19', 'keep', 'Chat', 'Reasoning blocks', cf('display.show_reasoning')),
  row('S20', 'keep', 'Chat', 'Image attachments', cf('agent.image_input_mode')),
  row('S21', 'keep', 'Chat', 'Max preview / image load size', st('chat', 'attachment-size')),

  // ── Appearance ──
  row('S22', 'keep', 'Appearance', 'Language', [APPEARANCE_GENERAL, ...st('appearance', 'language')]),
  row('S23', 'keep', 'Appearance', 'Theme (light/dark/system, gallery, remove)', [
    'settings:config:appearance/theme',
    ...st('appearance', 'theme')
  ]),
  row('S24', 'remove', 'Appearance', 'Search and install VS Code Marketplace themes', [
    'settings-control:marketplace-themes'
  ]),
  row('S25', 'keep', 'Appearance', 'UI scale, chat text size, chat font, terminal font', [
    APPEARANCE_TYPOGRAPHY,
    ...st('appearance', 'ui-scale', 'chat-text-scale', 'chat-font', 'terminal-font')
  ]),
  row('S26', 'keep', 'Appearance', 'Interface mode (simple / advanced)', [
    APPEARANCE_LAYOUT,
    ...st('appearance', 'interface-mode')
  ]),
  row('S27', 'keep', 'Appearance', 'Layout: density, tab strip, app actions, floating composer, file browser', [
    APPEARANCE_LAYOUT,
    ...st('appearance', 'session-density', 'tab-strip', 'app-actions', 'composer-popout', 'file-browser')
  ]),
  row('S28', 'keep', 'Appearance', 'Minimize to tray', [APPEARANCE_LAYOUT, ...st('appearance', 'minimize-to-tray')]),
  row('S29', 'keep', 'Appearance', 'Window translucency', [APPEARANCE_LAYOUT, ...st('appearance', 'translucency')]),
  row('S30', 'keep', 'Appearance', 'Message display', [
    APPEARANCE_DISPLAY,
    APPEARANCE_LAYOUT,
    ...st(
      'appearance',
      'user-bubble',
      'text-direction',
      'backdrop',
      'hide-thread-timeline',
      'reactions',
      'vibe-hearts',
      'tool-view',
      'hide-code-diffs',
      'reasoning-collapsed'
    )
  ]),
  row('S31', 'keep', 'Appearance', 'Intro splash', [APPEARANCE_GENERAL, ...st('appearance', 'intro-splash')]),
  row('S32', 'disable', 'Appearance', 'Model pricing', [APPEARANCE_GENERAL, ...st('appearance', 'model-pricing')]),
  row('S33', 'keep', 'Appearance', 'Reopen last chat on launch', [
    APPEARANCE_GENERAL,
    ...st('appearance', 'resume-last-session')
  ]),
  row('S34', 'disable', 'Appearance', 'In-app tips (and reset)', [APPEARANCE_GENERAL, ...st('appearance', 'tips')]),
  row('S35', 'disable', 'Appearance', 'Guided tours', [APPEARANCE_GENERAL, ...st('appearance', 'tours')]),
  row('S36', 'disable', 'Appearance', 'Inline embeds (ask / always / off)', [
    APPEARANCE_DISPLAY,
    ...st('appearance', 'embeds')
  ]),
  row('S37', 'disable', 'Appearance', 'Pet: choose, size, roam, rename, export, uninstall', [
    'settings:config:appearance/pet',
    ...st('appearance', 'pet')
  ]),
  row('S38', 'remove', 'Appearance', 'Generate pet (palette)'),

  // ── Workspace ──
  row('S39', 'keep', 'Workspace', 'Default working directory', [WORKSPACE_PROJECTS, ...cf('terminal.cwd')]),
  row('S40', 'keep', 'Workspace', 'Repository scan (on/off, roots, exclusions)', [
    WORKSPACE_PROJECTS,
    ...cf('desktop.repo_scan_*')
  ]),
  row('S41', 'disable', 'Workspace', 'Persistent shell', [WORKSPACE_SHELL, ...cf('terminal.persistent_shell')]),
  row('S42', 'disable', 'Workspace', 'Environment passthrough', [WORKSPACE_SHELL, ...cf('terminal.env_passthrough')]),
  row('S43', 'disable', 'Workspace', 'Code execution mode, file read limit', [
    'settings:config:workspace/files',
    ...cf('code_execution.mode', 'file_read_max_chars')
  ]),

  // ── Safety ──
  row('S44', 'disable', 'Safety', 'Approval mode, approval timeout', [
    SAFETY_APPROVALS,
    ...cf('approvals.mode', 'approvals.timeout')
  ]),
  row('S45', 'disable', 'Safety', 'Confirm MCP reloads', [SAFETY_APPROVALS, ...cf('approvals.mcp_reload_confirm')]),
  row('S46', 'disable', 'Safety', 'Command allowlist', [SAFETY_APPROVALS, ...cf('command_allowlist')]),
  row('S47', 'disable', 'Safety', 'Redact secrets', [SAFETY_PRIVACY, ...cf('security.redact_secrets')]),
  row('S48', 'disable', 'Safety', 'Allow private URLs', [SAFETY_PRIVACY, ...cf('security.allow_private_urls')]),
  row('S49', 'remove', 'Safety', 'Share usage stats with Nous (and the composer consent strip)', [
    'settings-control:shared-metrics'
  ]),
  row('S50', 'keep', 'Safety', 'File checkpoints', ['settings:config:safety/checkpoints', ...cf('checkpoints.enabled')]),

  // ── Browser ──
  row('S51', 'disable', 'Browser', 'Use my real browser profile', [
    BROWSER,
    'settings:config:browser/profile',
    ...cf('browser.use_real_profile')
  ]),
  row('S52', 'disable', 'Browser', 'Private URLs; local browser for private URLs', [
    BROWSER,
    'settings:config:browser/network',
    ...cf('browser.allow_private_urls', 'browser.auto_local_for_private_urls')
  ]),

  // ── Passwords & Logins ──
  row('S53', 'disable', 'Passwords & Logins', 'Saved credentials', [VAULT, 'settings:vault/credentials']),
  row('S54', 'disable', 'Passwords & Logins', 'Password managers (Bitwarden, 1Password, local)', [
    VAULT,
    'settings:vault/sources'
  ]),

  // ── Memory & Context ──
  row('S55', 'disable', 'Memory & Context', 'Persistent memory, user profile (on/off)', [
    MEMORY_PERSISTENT,
    ...cf('memory.memory_enabled', 'memory.user_profile_enabled')
  ]),
  row('S56', 'disable', 'Memory & Context', 'Memory and profile budgets', [
    MEMORY_PERSISTENT,
    ...cf('memory.memory_char_limit', 'memory.user_char_limit')
  ]),
  row('S57', 'disable', 'Memory & Context', 'Memory provider and connect', [MEMORY_PERSISTENT, ...cf('memory.provider')]),
  row('S58', 'keep', 'Memory & Context', 'Memory layers summary', [MEMORY_PERSISTENT]),
  row('S59', 'disable', 'Memory & Context', 'Context engine and compression', [
    'settings:config:memory/context',
    ...cf('context.*', 'compression.*', 'auxiliary.compression.*')
  ]),

  // ── Voice ──
  row('S60', 'disable', 'Voice', 'Voice chat mode (including GPT Live)', [
    VOICE,
    VOICE_CONVERSATION,
    ...cf('voice.voice_chat_mode', 'voice.gpt_live.*')
  ]),
  row('S61', 'disable', 'Voice', 'Speech-to-text provider and options', [
    VOICE,
    'settings:config:voice/transcription',
    ...cf('stt.*')
  ]),
  row('S62', 'disable', 'Voice', 'Text-to-speech provider and options', [VOICE, VOICE_SPEECH, ...cf('tts.*')]),
  row('S63', 'disable', 'Voice', 'Auto-TTS, max recording length, client-direct', [
    VOICE,
    VOICE_CONVERSATION,
    VOICE_SPEECH,
    ...cf('voice.auto_tts', 'voice.max_recording_seconds', 'voice.client_direct')
  ]),

  // ── Advanced ──
  row('S64', 'keep', 'Advanced', 'Keep computer awake', [ADVANCED_DESKTOP, ...st('advanced', 'keep-awake')]),
  row('S65', 'disable', 'Advanced', 'Disable F12 DevTools', [ADVANCED_DESKTOP, ...st('advanced', 'disable-f12')]),
  row('S66', 'keep', 'Advanced', 'Always open links in external browser', [ADVANCED_DESKTOP]),
  row('S67', 'keep', 'Advanced', 'Quick entry and its shortcut', [
    ADVANCED_DESKTOP,
    ...st('advanced', 'quick-entry', 'quick-entry-shortcut')
  ]),
  row('S68', 'remove', 'Advanced', 'Run onboarding again', ['settings-control:rerun-onboarding']),
  row('S69', 'remove', 'Advanced', 'In-app update local changes', cf('updates.*')),
  row('S70a', 'keep', 'Advanced', 'Max agent steps', [ADVANCED_RUNTIME, ...cf('agent.max_turns')]),
  row('S70b', 'disable', 'Advanced', 'API retries, service tier', [
    ADVANCED_RUNTIME,
    ...cf('agent.api_max_retries', 'agent.service_tier')
  ]),
  row('S71', 'disable', 'Advanced', 'Enabled toolsets', [ADVANCED_TOOLS, ...cf('toolsets')]),
  row('S72', 'disable', 'Advanced', 'Tool-use enforcement', [ADVANCED_TOOLS, ...cf('agent.tool_use_enforcement')]),
  row('S73', 'disable', 'Advanced', 'Terminal backend (local, docker, singularity, modal, daytona, ssh)', [
    'settings:config:advanced/terminal',
    ...cf(
      'terminal.backend',
      'terminal.timeout',
      'terminal.docker_image',
      'terminal.singularity_image',
      'terminal.modal_image',
      'terminal.daytona_image'
    )
  ]),
  row('S74', 'disable', 'Advanced', 'Output limits; checkpoint limit', [
    ADVANCED_OUTPUT,
    ...cf('tool_output.*', 'checkpoints.max_snapshots')
  ]),

  // ── Notifications ──
  row('S75', 'keep', 'Notifications', 'Enable, test, per-kind alerts, permission, mute, completion sound', [
    NOTIFICATIONS,
    'settings:notifications/alerts',
    'settings:notifications/sounds',
    ...st(
      'notifications',
      'enable-all',
      'kind-approval',
      'kind-input',
      'kind-turn-done',
      'kind-turn-error',
      'kind-background-done',
      'kind-plugin',
      'browser-permission',
      'mute-sounds',
      'completion-sound'
    )
  ]),
  row('S76', 'remove', 'Notifications', 'Credit alerts', st('notifications', 'kind-credits')),

  // ── Billing ──
  row('S77', 'remove', 'Billing', 'Billing page: balance, plans, credits, auto-reload, portal, usage', ['settings:billing']),
  row('S78', 'remove', 'Billing', 'Billing entry points: plan gauge, credit-error links, /subscription, /upgrade, /topup, /usage'),

  // ── Providers ──
  row('S79', 'remove', 'Providers', 'Accounts (OAuth sign-in to model vendors)', [PROVIDERS, 'settings:providers/accounts']),
  row('S80', 'remove', 'Providers', 'API keys', [PROVIDERS, 'settings:providers/keys']),
  row('S81', 'disable', 'Providers', 'Custom endpoints', [PROVIDERS, 'settings:providers/custom-endpoints']),
  row('S82', 'disable', 'Providers', 'Local models (Hugging Face downloads, local server)', [
    PROVIDERS,
    'settings:providers/local'
  ]),

  // ── Gateways ──
  row('S83', 'disable', 'Gateways', 'Connection mode: Local', [
    GATEWAY,
    GATEWAY_CONNECTION,
    GATEWAY_MODE,
    'settings-control:gateway-mode-local'
  ]),
  row('S84', 'remove', 'Gateways', 'Hermes Cloud (sign-in, org picker, agents)', ['settings-control:gateway-mode-cloud']),
  row('S85', 'disable', 'Gateways', 'Remote gateway (URL, auth, test)', [
    GATEWAY,
    GATEWAY_CONNECTION,
    GATEWAY_MODE,
    'settings-control:gateway-mode-remote'
  ]),
  row('S86', 'disable', 'Gateways', 'SSH connection', [
    GATEWAY,
    GATEWAY_CONNECTION,
    GATEWAY_MODE,
    'settings-control:gateway-mode-ssh'
  ]),
  row('S87', 'disable', 'Gateways', 'Encrypt saved secrets with the OS keychain', [
    GATEWAY,
    GATEWAY_CONNECTION,
    ...st('gateway', 'keychain-encryption')
  ]),
  row('S88', 'keep', 'Gateways', 'Diagnostics › Open logs', [GATEWAY, GATEWAY_CONNECTION, ...st('gateway', 'diagnostics')]),
  row('S89', 'disable', 'Gateways', 'Saved connections', [GATEWAY, 'settings:gateway/devices']),
  row('S90', 'disable', 'Gateways', 'Remote updates (managed SSH)', [GATEWAY, 'settings:gateway/managed-updates']),

  // ── Web access ──
  row('S91', 'remove', 'Web access', 'Web access (serve the app on the network)', ['settings:web-access']),

  // ── Keyboard Shortcuts ──
  row('S92', 'keep', 'Keyboard Shortcuts', 'Key bindings', ['settings:keybinds', 'settings:keybinds/shortcuts']),
  row('S93', 'keep', 'Keyboard Shortcuts', 'Tap to summon HUD', [
    'settings:keybinds',
    'settings:keybinds/hud-gesture',
    ...st('keybinds', 'hud-modifier')
  ]),
  row('S94', 'keep', 'Keyboard Shortcuts', 'Screenshot shortcut', [
    'settings:keybinds',
    'settings:keybinds/screen-capture',
    ...st('keybinds', 'screenshot')
  ]),

  // ── Tools & Keys ──
  row('S95', 'disable', 'Tools & Keys', 'Tool API keys (Exa, Firecrawl, Tavily, Brave, GitHub, …)', [KEYS, KEYS_TOOLS]),
  row('S96', 'remove', 'Tools & Keys', 'Nous tool gateway URLs and token', cred('TOOL_GATEWAY_*')),
  row('S97', 'remove', 'Tools & Keys', 'SUDO_PASSWORD', cred('SUDO_PASSWORD')),
  row('S98', 'disable', 'Tools & Keys', 'Prefill messages file, ephemeral system prompt', [
    KEYS,
    KEYS_SETTINGS,
    ...cred('HERMES_PREFILL_MESSAGES_FILE', 'HERMES_EPHEMERAL_SYSTEM_PROMPT')
  ]),
  row('S99', 'disable', 'Tools & Keys', 'API server, webhook, gateway proxy, allow-all-users', [
    KEYS,
    KEYS_SETTINGS,
    ...cred('API_SERVER_*', 'WEBHOOK_*', 'GATEWAY_PROXY_*', 'GATEWAY_ALLOW_ALL_USERS')
  ]),

  // ── Sessions ──
  row('S100', 'keep', 'Sessions', 'Archived sessions (unarchive, delete)', ['settings:sessions', SESSIONS_ARCHIVED]),
  row('S101', 'keep', 'Sessions', 'Auto-archive stale chats', [
    'settings:sessions',
    SESSIONS_ARCHIVED,
    ...st('sessions', 'auto-archive')
  ]),
  row('S102', 'keep', 'Sessions', 'Default project directory', ['settings:sessions', 'settings:sessions/default-directory']),

  // ── Plugins ──
  row('S103', 'keep', 'Plugins', 'Plugins tab (Athena page)', ['settings:plugins']),

  // ── About ──
  row('S104', 'keep', 'About', 'Version and details', ['settings:about', ABOUT_UPDATES]),
  row('S105', 'keep', 'About', 'Updates card', ['settings:about', ABOUT_UPDATES, ...st('about', 'updates')]),
  row('S106', 'remove', 'About', 'Update channel', ['settings-control:update-channel']),
  row('S107', 'disable', 'About', 'Backend update card', ['settings-control:backend-update-card']),
  row('S108', 'disable', 'About', 'Uninstall', ['settings:about', 'settings:about/uninstall', 'settings-control:uninstall']),

  // ── Surfaces outside Settings (entries: slice 16) ──
  row('S109', 'remove', 'Surfaces outside Settings', 'Stock onboarding (provider picker, key entry)'),
  row('S110', 'remove', 'Surfaces outside Settings', 'Free-tier sign-in dialog, intro and terms bar'),
  row('S111', 'disable', 'Surfaces outside Settings', 'Messaging page (Telegram, WhatsApp, Slack, relay, pairing)'),
  row('S112', 'disable', 'Surfaces outside Settings', 'Webhooks page'),
  row('S113', 'disable', 'Surfaces outside Settings', 'Scheduled jobs (cron)'),
  row('S114', 'remove', 'Surfaces outside Settings', 'Command Center › Update Hermes'),
  row('S115', 'keep', 'Surfaces outside Settings', 'Command Center › Restart gateway'),
  row('S116', 'disable', 'Surfaces outside Settings', 'Command Center › Usage analytics'),
  row('S117', 'remove', 'Surfaces outside Settings', 'Send diagnostics to Nous; /debug'),
  row('S118a', 'disable', 'Surfaces outside Settings', '/approvals'),
  row('S118b', 'remove', 'Surfaces outside Settings', '/yolo'),
  row('S119', 'disable', 'Surfaces outside Settings', '/tools'),
  row('S120', 'keep', 'Surfaces outside Settings', '/reasoning'),
  row('S121', 'keep', 'Surfaces outside Settings', '/personality, /skin'),
  row('S122', 'disable', 'Surfaces outside Settings', 'Profiles: create, import'),
  row('S123', 'disable', 'Surfaces outside Settings', 'Bot Mode (bundled hermes-bots plugin)'),
  row('S124', 'disable', 'Surfaces outside Settings', 'In-app terminal pane')
])

export const FEATURE_ROW_BY_ID: ReadonlyMap<string, FeatureRow> = new Map(FEATURE_ROWS.map(r => [r.id, r]))

/** The audit's recommendation: keep → on, disable → off, remove → no flag (null). */
export function buildDefault(mark: FeatureMark): FeatureFlag | null {
  return mark === 'keep' ? 'on' : mark === 'disable' ? 'off' : null
}

/** The registry as the admin API validates it (`features.json`): ids, marks and build defaults. */
export function exportedFeatureRegistry() {
  return {
    schema_version: 1,
    source: 'hermes desktop fork: apps/desktop/electron/athena/feature-registry.ts',
    features: FEATURE_ROWS.map(r => ({ id: r.id, mark: r.mark, default: buildDefault(r.mark), area: r.area, title: r.title }))
  }
}

// ── Evaluating flags ────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The master switch for feature filtering (`managed.features`). `report` is
 * treated as `enforce` until slice 19 adds would-be-block logging: the
 * restrictive reading, never a silent opening.
 */
export function featureMode(config: unknown): FeatureMode {
  const mode = isRecord(config) && isRecord(config.managed) ? config.managed.features : undefined

  return mode === 'off' || mode === 'report' ? mode : 'enforce'
}

export interface FeatureStates {
  /** Whether filtering applies (false when the master switch is `off`). */
  filtering: boolean
  mode: FeatureMode
  on: (rowId: string) => boolean
}

/**
 * Row flags for an effective client config (main has already layered build
 * default < bundled default < server config < dev override; the config's
 * `features` holds the exceptions). Remove rows are always off; unknown ids
 * and values other than "on"/"off" are ignored.
 */
export function featureStates(config: unknown): FeatureStates {
  const overrides = isRecord(config) && isRecord(config.features) ? config.features : {}
  const mode = featureMode(config)
  const states = new Map<string, boolean>()

  for (const r of FEATURE_ROWS) {
    const flag = buildDefault(r.mark)
    const override = overrides[r.id]
    states.set(r.id, flag !== null && (override === 'on' || override === 'off' ? override : flag) === 'on')
  }

  return {
    filtering: mode !== 'off',
    mode,
    // With the master switch off nothing is filtered, except remove rows: they are not in this variant.
    on: rowId => {
      const mark = FEATURE_ROW_BY_ID.get(rowId)?.mark

      if (mark === undefined || mark === 'remove') {
        return false
      }

      return mode === 'off' || states.get(rowId) === true
    }
  }
}

interface EntryIndex {
  exact: ReadonlyMap<string, readonly string[]>
  prefixes: readonly (readonly [string, readonly string[]])[]
}

function buildIndex(rows: readonly FeatureRow[]): EntryIndex {
  const exact = new Map<string, string[]>()
  const prefixes = new Map<string, string[]>()

  for (const r of rows) {
    for (const entry of r.entries) {
      const target = entry.endsWith('*') ? prefixes : exact
      const key = entry.endsWith('*') ? entry.slice(0, -1) : entry
      target.set(key, [...(target.get(key) ?? []), r.id])
    }
  }

  return { exact, prefixes: [...prefixes].sort(([a], [b]) => b.length - a.length) }
}

const INDEX = buildIndex(FEATURE_ROWS)

/** The rows that reach an entry id (exact first, then the longest `*` prefix), or null when no row lists it. */
export function rowsForEntry(entryId: string): readonly string[] | null {
  const exact = INDEX.exact.get(entryId)

  if (exact) {
    return exact
  }

  for (const [prefix, rows] of INDEX.prefixes) {
    if (entryId.startsWith(prefix)) {
      return rows
    }
  }

  return null
}

/** Every registered entry id (patterns included), for surfaces that pre-compute what to hide. */
export function registeredEntries(): readonly string[] {
  return [...new Set(FEATURE_ROWS.flatMap(r => r.entries))]
}

/** The entry filter for a config: an entry is allowed while any row reaching it is on. */
export function featureEntryFilter(config: unknown): (entryId: string) => boolean {
  const states = featureStates(config)
  const cache = new Map<string, boolean>()

  return entryId => {
    let allowed = cache.get(entryId)

    if (allowed === undefined) {
      const rows = rowsForEntry(entryId)
      allowed = rows === null || rows.some(states.on)
      cache.set(entryId, allowed)
    }

    return allowed
  }
}
