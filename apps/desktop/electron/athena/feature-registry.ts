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
// Outside Settings (slice 16):
// - `keybind:<action id>`: a shortcut (dispatch, plugin runAction, the panel);
// - `route:<path>`, `command-center:<section|action>`: app pages and Command
//   Center tabs and buttons (route guard, in-app open targets, deep links);
// - `palette:<item id>`, `statusbar:<item id>`, `nav:<sidebar row id>`;
// - `slash:<command>`: answered "Not available in Athena";
// - `error-action:<action id>`: chat error-card buttons;
// - `deep-link:<kind>[/<name>]`: OS deep links other than `open`;
// - `plugin:<bundled plugin id>`, `pane:<id>`, `dialog:<name>`.
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
// Backend surfaces (slice 17), refused while every row listing them is off:
// - `rest:<path>` (any method), `rest:<METHOD> <path>`, `rest:WRITE <path>` (any method but GET/HEAD);
// - `rpc:<method>`, `rpc:<method>/<action>` (backend-policy.ts names the action of a multiplexed method);
// - `ipc:<channel>`: the channel is not registered in Electron main.
const rest = (...paths: string[]) => paths.map(path => `rest:${path}`)
const rpc = (...methods: string[]) => methods.map(method => `rpc:${method}`)
const ipc = (...channels: string[]) => channels.map(channel => `ipc:${channel}`)

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
  row('S07', 'remove', 'Model', 'Main model › Set up provider / API key', [
    MODEL_MAIN,
    ...rpc('model.save_key'),
    ...rest('/api/providers/validate')
  ]),
  row('S08a', 'keep', 'Model', 'Reasoning effort', [MODEL_MAIN]),
  row('S08b', 'disable', 'Model', 'Speed / Fast (service tier)', [MODEL_MAIN, 'settings-control:main-speed']),
  row('S09', 'disable', 'Model', 'Context window override', [MODEL_MAIN, ...cf('model_context_length')]),
  row('S10', 'disable', 'Model', 'Fallback models', ['settings:config:model/fallbacks', ...cf('fallback_providers')]),
  row('S11', 'disable', 'Model', 'Auxiliary models', [
    'settings:config:model/auxiliary',
    ...rest('WRITE /api/model/auxiliary')
  ]),
  row('S12', 'disable', 'Model', 'Mixture of Agents', [
    'settings:config:model/moa',
    ...cf('moa.*'),
    ...rest('WRITE /api/model/moa')
  ]),
  row('S13', 'disable', 'Model', 'Subagents › Routing', [
    MODEL_DELEGATION,
    'settings-control:delegation-routing',
    ...rest('WRITE /api/delegation/*')
  ]),
  row('S14', 'remove', 'Model', 'Subagents › "Install plugin" (Advanced Delegation)', [
    'settings-control:delegation-install-plugin'
  ]),
  row('S15', 'disable', 'Model', 'Subagents › model, provider, limits, timeout, effort', [
    MODEL_DELEGATION,
    ...cf('delegation.*'),
    ...rest('WRITE /api/delegation/*')
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
    'settings-control:marketplace-themes',
    ...ipc('hermes:vscode-theme:search', 'hermes:vscode-theme:fetch')
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
    ...st('appearance', 'pet'),
    'palette:appearance-pets',
    // Writes only: the floating pet and the gallery read pet.info / pet.gallery whatever the flag.
    ...rpc('pet.select', 'pet.disable', 'pet.scale', 'pet.export', 'pet.rename', 'pet.remove', 'pet.hatch', 'pet.cancel')
  ]),
  row('S38', 'remove', 'Appearance', 'Generate pet (palette)', ['palette:appearance-generate-pet', ...rpc('pet.generate*')]),

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
    ...cf('approvals.mode', 'approvals.timeout'),
    'statusbar:approval-mode'
  ]),
  row('S45', 'disable', 'Safety', 'Confirm MCP reloads', [SAFETY_APPROVALS, ...cf('approvals.mcp_reload_confirm')]),
  row('S46', 'disable', 'Safety', 'Command allowlist', [SAFETY_APPROVALS, ...cf('command_allowlist')]),
  row('S47', 'disable', 'Safety', 'Redact secrets', [SAFETY_PRIVACY, ...cf('security.redact_secrets')]),
  row('S48', 'disable', 'Safety', 'Allow private URLs', [SAFETY_PRIVACY, ...cf('security.allow_private_urls')]),
  row('S49', 'remove', 'Safety', 'Share usage stats with Nous (and the composer consent strip)', [
    'settings-control:shared-metrics',
    'dialog:shared-metrics-consent',
    ...rpc('shared_metrics.*'),
    ...ipc('hermes:desktop-metrics:set-enabled')
  ]),
  row('S50', 'keep', 'Safety', 'File checkpoints', [
    'settings:config:safety/checkpoints',
    ...cf('checkpoints.enabled')
  ]),

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
  row('S53', 'disable', 'Passwords & Logins', 'Saved credentials', [VAULT, 'settings:vault/credentials', ...rpc('vault.*')]),
  row('S54', 'disable', 'Passwords & Logins', 'Password managers (Bitwarden, 1Password, local)', [
    VAULT,
    'settings:vault/sources',
    ...rpc('vault.*')
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
  row('S57', 'disable', 'Memory & Context', 'Memory provider and connect', [
    MEMORY_PERSISTENT,
    ...cf('memory.provider'),
    ...rest('WRITE /api/memory/providers/*')
  ]),
  row('S58', 'keep', 'Memory & Context', 'Memory layers summary', [MEMORY_PERSISTENT]),
  row('S59', 'disable', 'Memory & Context', 'Context engine and compression', [
    'settings:config:memory/context',
    ...cf('context.*', 'compression.*', 'auxiliary.compression.*')
  ]),

  // ── Voice ──
  row('S60', 'disable', 'Voice', 'Voice chat mode (including GPT Live)', [
    VOICE,
    VOICE_CONVERSATION,
    ...cf('voice.voice_chat_mode', 'voice.gpt_live.*'),
    ...rest('/api/audio/voice-live/*')
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
  // Off: DevTools do not open (F12, the inspect chord, the View menu item) and the renderer cannot change the
  // F12 preference; on (dev override): the stock behaviour and preference (main-policy.ts).
  row('S65', 'disable', 'Advanced', 'Disable F12 DevTools', [
    ADVANCED_DESKTOP,
    ...st('advanced', 'disable-f12'),
    'devtools:open',
    ...ipc('hermes:devtools:disable-f12')
  ]),
  row('S66', 'keep', 'Advanced', 'Always open links in external browser', [ADVANCED_DESKTOP]),
  row('S67', 'keep', 'Advanced', 'Quick entry and its shortcut', [
    ADVANCED_DESKTOP,
    ...st('advanced', 'quick-entry', 'quick-entry-shortcut')
  ]),
  row('S68', 'remove', 'Advanced', 'Run onboarding again', ['settings-control:rerun-onboarding', ...rpc('onboarding.start', 'onboarding.set_run')]),
  row('S69', 'remove', 'Advanced', 'In-app update local changes', [...cf('updates.*'), ...ipc('hermes:updates:apply')]),
  row('S70a', 'keep', 'Advanced', 'Max agent steps', [ADVANCED_RUNTIME, ...cf('agent.max_turns')]),
  row('S70b', 'disable', 'Advanced', 'API retries, service tier', [
    ADVANCED_RUNTIME,
    ...cf('agent.api_max_retries', 'agent.service_tier')
  ]),
  row('S71', 'disable', 'Advanced', 'Enabled toolsets', [ADVANCED_TOOLS, ...cf('toolsets')]),
  row('S72', 'disable', 'Advanced', 'Tool-use enforcement', [ADVANCED_TOOLS, ...cf('agent.tool_use_enforcement')]),
  row('S73', 'disable', 'Advanced', 'Terminal backend (local, docker, singularity, modal, daytona, ssh)', [
    'settings:config:advanced/terminal',
    ...rest('WRITE /api/tools/terminal/backend'),
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
  row('S77', 'remove', 'Billing', 'Billing page: balance, plans, credits, auto-reload, portal, usage', [
    'settings:billing',
    ...rpc('billing.*', 'subscription.*'),
    ...rest('/api/portal*', '/api/providers/oauth/nous/*')
  ]),
  row(
    'S78',
    'remove',
    'Billing',
    'Billing entry points: plan gauge, credit-error links, /subscription, /upgrade, /topup, /usage',
    [
      'statusbar:plan-usage',
      'error-action:use_credits',
      'error-action:open_billing',
      'slash:subscription',
      'slash:upgrade',
      'slash:topup',
      'slash:usage'
    ]
  ),

  // ── Providers ──
  row('S79', 'remove', 'Providers', 'Accounts (OAuth sign-in to model vendors)', [
    PROVIDERS,
    'settings:providers/accounts',
    'error-action:sign_in_again',
    ...rest('/api/providers/oauth*'),
    ...rpc('model.disconnect')
  ]),
  // `env:*`: an /api/env write (or reveal) of a key no `credential:` entry names: vendor and tool API keys.
  row('S80', 'remove', 'Providers', 'API keys', [
    PROVIDERS,
    'settings:providers/keys',
    'error-action:update_api_key',
    'env:*'
  ]),
  row('S81', 'disable', 'Providers', 'Custom endpoints', [
    PROVIDERS,
    'settings:providers/custom-endpoints',
    ...rest('/api/providers/custom-endpoints*')
  ]),
  row('S82', 'disable', 'Providers', 'Local models (Hugging Face downloads, local server)', [
    PROVIDERS,
    'settings:providers/local',
    ...rest('/api/local-models/*')
  ]),

  // ── Gateways ──
  row('S83', 'disable', 'Gateways', 'Connection mode: Local', [
    GATEWAY,
    GATEWAY_CONNECTION,
    GATEWAY_MODE,
    'settings-control:gateway-mode-local',
    'statusbar:gateway-switcher'
  ]),
  row('S84', 'remove', 'Gateways', 'Hermes Cloud (sign-in, org picker, agents)', [
    'settings-control:gateway-mode-cloud',
    ...ipc('hermes:cloud:*')
  ]),
  row('S85', 'disable', 'Gateways', 'Remote gateway (URL, auth, test)', [
    GATEWAY,
    GATEWAY_CONNECTION,
    GATEWAY_MODE,
    'settings-control:gateway-mode-remote',
    'statusbar:gateway-switcher',
    ...ipc(
      'hermes:connection-config:probe',
      'hermes:connection-config:test',
      'hermes:connection-config:oauth-login',
      'hermes:connection-config:oauth-logout'
    )
  ]),
  row('S86', 'disable', 'Gateways', 'SSH connection', [
    GATEWAY,
    GATEWAY_CONNECTION,
    GATEWAY_MODE,
    'settings-control:gateway-mode-ssh',
    'statusbar:gateway-switcher',
    ...ipc('hermes:ssh-config:*')
  ]),
  row('S87', 'disable', 'Gateways', 'Encrypt saved secrets with the OS keychain', [
    GATEWAY,
    GATEWAY_CONNECTION,
    ...st('gateway', 'keychain-encryption'),
    ...ipc('hermes:secret-storage:set')
  ]),
  row('S88', 'keep', 'Gateways', 'Diagnostics › Open logs', [
    GATEWAY,
    GATEWAY_CONNECTION,
    ...st('gateway', 'diagnostics')
  ]),
  row('S89', 'disable', 'Gateways', 'Saved connections', [
    GATEWAY,
    'settings:gateway/devices',
    'statusbar:gateway-switcher'
  ]),
  row('S90', 'disable', 'Gateways', 'Remote updates (managed SSH)', [
    GATEWAY,
    'settings:gateway/managed-updates',
    ...ipc('hermes:connections:update-managed', 'hermes:connections:update-all')
  ]),

  // ── Web access ──
  row('S91', 'remove', 'Web access', 'Web access (serve the app on the network)', [
    'settings:web-access',
    ...rest('/api/webapp-access/*')
  ]),

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
  row('S95', 'disable', 'Tools & Keys', 'Tool API keys (Exa, Firecrawl, Tavily, Brave, GitHub, …)', [
    KEYS,
    KEYS_TOOLS,
    'env:*'
  ]),
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
  row('S102', 'keep', 'Sessions', 'Default project directory', [
    'settings:sessions',
    'settings:sessions/default-directory'
  ]),

  // ── Plugins ──
  row('S103', 'keep', 'Plugins', 'Plugins tab (Athena page)', ['settings:plugins']),

  // ── About ──
  row('S104', 'keep', 'About', 'Version and details', ['settings:about', ABOUT_UPDATES]),
  row('S105', 'keep', 'About', 'Updates card', ['settings:about', ABOUT_UPDATES, ...st('about', 'updates')]),
  row('S106', 'remove', 'About', 'Update channel', ['settings-control:update-channel', ...ipc('hermes:updates:channel:set')]),
  row('S107', 'disable', 'About', 'Backend update card', ['settings-control:backend-update-card']),
  row('S108', 'disable', 'About', 'Uninstall', [
    'settings:about',
    'settings:about/uninstall',
    'settings-control:uninstall',
    ...ipc('hermes:uninstall:*')
  ]),

  // ── Surfaces outside Settings (entries: slice 16) ──
  row('S109', 'remove', 'Surfaces outside Settings', 'Stock onboarding (provider picker, key entry)'),
  row('S110', 'remove', 'Surfaces outside Settings', 'Free-tier sign-in dialog, intro and terms bar', [
    'statusbar:free-tier',
    'error-action:sign_in_free_tier',
    ...rpc('free_tier.*'),
    ...ipc('hermes:freeTierChallenge:run')
  ]),
  row('S111', 'disable', 'Surfaces outside Settings', 'Messaging page (Telegram, WhatsApp, Slack, relay, pairing)', [
    'route:/messaging',
    'keybind:nav.messaging',
    'palette:nav-messaging',
    'nav:messaging',
    ...rest('/api/messaging/*', '/api/pairing*')
  ]),
  row('S112', 'disable', 'Surfaces outside Settings', 'Webhooks page', [
    'route:/webhooks',
    'statusbar:webhooks',
    ...rest('/api/webhooks*')
  ]),
  row('S113', 'disable', 'Surfaces outside Settings', 'Scheduled jobs (cron)', [
    'route:/cron',
    'keybind:nav.cron',
    'palette:nav-cron',
    'nav:cron',
    'statusbar:cron',
    ...rest('/api/cron/*'),
    ...rpc('cron.manage')
  ]),
  row('S114', 'remove', 'Surfaces outside Settings', 'Command Center › Update Hermes', [
    'command-center:update-hermes',
    'palette:cc-update-hermes',
    ...rest('/api/hermes/update*')
  ]),
  row('S115', 'keep', 'Surfaces outside Settings', 'Command Center › Restart gateway', [
    'command-center:restart-gateway',
    'palette:cc-restart-gateway'
  ]),
  row('S116', 'disable', 'Surfaces outside Settings', 'Command Center › Usage analytics', [
    'command-center:usage',
    'palette:cc-usage',
    ...rest('/api/analytics/*')
  ]),
  row('S117', 'remove', 'Surfaces outside Settings', 'Send diagnostics to Nous; /debug', [
    'slash:debug',
    'dialog:send-diagnostics',
    ...rpc('diagnostics.share_nous'),
    ...rest('/api/ops/debug-share')
  ]),
  row('S118a', 'disable', 'Surfaces outside Settings', '/approvals', ['slash:approvals']),
  row('S118b', 'remove', 'Surfaces outside Settings', '/yolo', ['slash:yolo', ...rpc('config.set/yolo')]),
  row('S119', 'disable', 'Surfaces outside Settings', '/tools', ['slash:tools']),
  row('S120', 'keep', 'Surfaces outside Settings', '/reasoning', ['slash:reasoning']),
  row('S121', 'keep', 'Surfaces outside Settings', '/personality, /skin', ['slash:personality', 'slash:skin']),
  row('S122', 'disable', 'Surfaces outside Settings', 'Profiles: create, import', [
    'keybind:profile.create',
    'dialog:create-profile',
    ...rest('POST /api/profiles', '/api/profiles/import'),
    ...rpc('profiles.create')
  ]),
  row('S123', 'disable', 'Surfaces outside Settings', 'Bot Mode (bundled hermes-bots plugin)', ['plugin:hermes-bots']),
  row('S124', 'disable', 'Surfaces outside Settings', 'In-app terminal pane', [
    'pane:terminal',
    'keybind:view.showTerminal',
    'keybind:view.newTerminal',
    'keybind:view.nextTerminal',
    'keybind:view.prevTerminal',
    'statusbar:terminal',
    'palette:view.showTerminal',
    ...ipc('hermes:terminal:*')
  ])
])

export const FEATURE_ROW_BY_ID: ReadonlyMap<string, FeatureRow> = new Map(FEATURE_ROWS.map(r => [r.id, r]))

/** The audit's recommendation: keep → on, disable → off, remove → no flag (null). */
export function buildDefault(mark: FeatureMark): FeatureFlag | null {
  return mark === 'keep' ? 'on' : mark === 'disable' ? 'off' : null
}

/**
 * Config fields that are not hermes config keys: the Settings schema invents them and the backend maps them
 * (`model_context_length` is written as `model.context_length`, 0 = auto, key removed). Not pinned: hermes has
 * no default for the real key, so there is no Athena value to pin it at.
 */
const VIRTUAL_CONFIG_FIELDS: ReadonlySet<string> = new Set(['model_context_length'])

/**
 * The hermes config keys a row's managed-scope pins cover while it is off (slice 17): its `config-field:` entries,
 * as dotted keys. A trailing `*` covers every key with that prefix (`moa.*` is the whole `moa` section,
 * `desktop.repo_scan_*` every `desktop.repo_scan_…` key). `athena config apply` pins them at the Athena value.
 */
export function rowConfigKeys(r: Pick<FeatureRow, 'entries'>): string[] {
  return r.entries
    .filter(entry => entry.startsWith('config-field:'))
    .map(entry => entry.slice('config-field:'.length))
    .filter(key => !VIRTUAL_CONFIG_FIELDS.has(key))
}

/**
 * The registry as the server sees it (`features.json`): ids, marks and build defaults (the admin API validates
 * `features` against them), and per row the config keys `athena config apply` pins while the row is off.
 */
export function exportedFeatureRegistry() {
  return {
    schema_version: 1,
    source: 'hermes desktop fork: apps/desktop/electron/athena/feature-registry.ts',
    features: FEATURE_ROWS.map(r => ({
      id: r.id,
      mark: r.mark,
      default: buildDefault(r.mark),
      area: r.area,
      title: r.title,
      config_keys: rowConfigKeys(r)
    }))
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
  /** The row's own flag, whatever the master switch says (remove rows and unknown ids: false). */
  flag: (rowId: string) => boolean
  mode: FeatureMode
  /** Whether the row is reachable under the master switch (what every surface filters by). */
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

  const flag = (rowId: string) => FEATURE_ROW_BY_ID.get(rowId)?.mark !== 'remove' && states.get(rowId) === true

  return {
    filtering: mode !== 'off',
    flag,
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
