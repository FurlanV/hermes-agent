# Athena branding (SickKids)

This folder turns the Hermes desktop app into **Athena**, made by SickKids, at
build time. It lives on the fork's Athena branch as a small diff kept inside
`apps/desktop`. No Python changes: the hermes runtime is unmodified.

`branding.json` is the one place to change names, ids, publisher and colours.

## Build

```sh
export PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$PATH"   # Node >= 26, pnpm 12 via corepack
pnpm install --frozen-lockfile                              # once, at the repo root
apps/desktop/src/athena/scripts/build-mac-dev.sh            # ~3 min; prints release/mac-arm64/Athena.app
```

The build is unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`, `--dir`, no
publish). Signing and notarization are planned separately (P09).

To run it against the pinned hermes, start it through the Athena launcher
(`athena/client/installer/macos/dev/athena-desktop.sh`), which sets
`HERMES_HOME` and `HERMES_DESKTOP_HERMES` and execs
`Athena.app/Contents/MacOS/Athena`. A Finder launch inherits neither, and the
app would then try the GitHub bootstrap. `build-mac-dev.sh --launch` does
both steps when `ATHENA_REPO` (or `ATHENA_DESKTOP_LAUNCHER`) is set.

## Icons

`assets/source/sickkids-logo.svg` is a byte copy of
`athena/shared/logo/The_Hospital_for_Sick_Children_Logo.svg` (the athena
repo is the source of truth; `branding.json` pins its sha256 as `logoSha256`).
The logo is a wordmark with no separable emblem, so the square mark is the
full wordmark on a rounded tile on the macOS icon grid:

- `assets/source/athena-mark.svg`: white tile, logo colours (the app icon);
- `assets/source/athena-mark-dark.svg`: Athena dark tile, wordmark reversed to white.

The mark is pending sign-off from SickKids communications.

```sh
apps/desktop/src/athena/scripts/make-icons.sh          # rewrite every icon file
apps/desktop/src/athena/scripts/make-icons.sh --check  # fail if any icon is stale
```

It renders with `rsvg-convert`, packs `.icns` with `iconutil` and `.ico`
with a few lines of Python, and writes over the upstream paths
(`assets/icon.*`, `assets/icon-dark.*`, `assets/icon-mac.png`, the
`assets/icon.icon` layers and `public/apple-touch-icon.png`). Output is
byte-for-byte repeatable. The Icon Composer package keeps the upstream
`icon.json`; electron-builder compiles it only with `actool` from Xcode 26,
otherwise it packs `icon.icns` alone (which `after-pack.mjs` restores anyway).
The Windows MSIX tiles in `assets/appx/` stay stock (Windows is out of scope).

## Colours and splash

- `theme.ts` is the `athena` skin, built from `branding.colors` (neutrals are
  mixed from foreground into background). It is the default skin
  (`DEFAULT_SKIN_NAME`), so a fresh profile paints Athena; other skins stay
  pickable in Settings. Its typography sets `fontUrl: ''` so the Nous skin's
  Google Fonts stylesheet underneath is never fetched.
- `index.html` pre-paints the Athena background (`#ffffff` / `#0b1f33` until
  the first theme apply stores the real one), sets `theme-color` and the page
  title, so the first window shows no white flash.
- `brand-plugin.tsx` (bundled through `src/plugins/athena-brand/plugin.tsx`)
  contributes `splash.tsx` to `chat.empty` with the lowest order, so cards
  other plugins add to that area, such as the Athena sign-in card, render
  below it. The thread shows the `chat.empty` slot on a fresh draft too, in
  place of core's "HERMES AGENT" intro; the Intro Splash toggle in Settings
  still turns it off.

## SickKids instead of Nous Research

`nous-inventory.md` lists every Nous mention in `apps/desktop` with its kind
and action (replace / hide / keep, D05's rules), generated from the upstream
base by `scripts/nous-inventory.mjs`:

```sh
node apps/desktop/src/athena/scripts/nous-inventory.mjs          # regenerate
node apps/desktop/src/athena/scripts/nous-inventory.mjs --check  # stale? unclassified? replace left?
```

- **Replace**: maker / publisher / ids now read `branding.json` (About panel
  copyright through the identity, `package.json` author and copyright, MSIX
  publisher, Linux maintainer, Windows exe metadata). Docs and support links on
  the demo path point at `supportUrl` through `strings.ts`.
- **Hide**: Nous-hosted services are never renamed. `strings.ts`
  (`hideNousServices`) filters the Nous Portal provider at its choke points:
  `sortProviders` (every OAuth provider list, onboarding and Settings), the
  onboarding key form's featured row, and the Settings key groups. Free-tier,
  billing and cloud surfaces only appear with a Nous account, which the Athena
  profile never enables (`nous.guest: false`). Rows marked `p10` are off the
  demo path and not patched yet.
- **Keep**: MIT licence and copyright credits, comments, identifiers, tests,
  developer docs, and the stock-variant fallback literals.

## What the `athena` variant changes

`HERMES_DESKTOP_VARIANT=athena` selects a bootstrap-shaped build (no bundled
payload) with:

| Value | Athena | Stock |
|---|---|---|
| app / bundle id | `ca.sickkids.athena` | `com.nousresearch.hermes` |
| display / executable name | `Athena` | `Hermes` |
| userData | `~/Library/Application Support/Athena` | `…/Hermes` |
| update feed | none (`channel: null`, no `app-update.yml`) | GitHub / R2 |
| install stamp `updateMechanism` | `external` (MDM owns updates) | `self` |
| MSIX publisher display name | `SickKids` | `Nous Research` |

`artifactNamePascal` is `SickKidsAthena`, deliberately different from
`appNamePascal` (`Athena`). That difference is how the runtime
(`electron/product-identity.ts`) decides to pin its own userData and app
name, and how the builder sets `productName` before `main.ts` runs. The
`hermes://` protocol scheme and the `hermes` CLI name stay.

The MSIX publisher subject (`msixPublisher`) and `supportUrl` are staged
placeholders until the SickKids code-signing certificate and help page exist.

## Upstream files touched

Keep the diff to these, plus this folder (D05 › Upstream files touched).

| File | Change |
|---|---|
| `product-identity.cjs` | `athena` variant read from `branding.json` |
| `scripts/write-build-stamp.mjs` | `athena` → `updateMechanism: 'external'`, payload `bootstrap`, stamp field `brand: 'athena'` |
| `scripts/bundle-electron-main.mjs` | Re-derive the `athena` identity from the stamp's `brand` (the stamp payload stays `bootstrap`). Not in D05's original list; needed so the baked runtime identity is Athena, not Hermes |
| `electron-builder.config.cjs` | MSIX publisher from `branding.json` |
| `assets/icon.{icns,ico,png}`, `assets/icon-dark.{icns,ico,png}`, `assets/icon-mac.png`, `assets/icon.icon/Assets/*.png` | Binary replace by `make-icons.sh` |
| `public/apple-touch-icon.png` | Binary replace by `make-icons.sh` |
| `electron/main.ts` | The four main-window `title: 'Hermes'` literals → `APP_NAME`; the Windows AUMID fallback → the identity `appId` |
| `electron/challenge-window.ts` | Window title from the identity display name. Not in D05's list; it was the last `'Hermes'` window-title literal in the main process |
| `index.html` | Title, `theme-color`, pre-paint fallback colours |
| `src/themes/presets.ts` | Register the `athena` skin; `DEFAULT_SKIN_NAME = 'athena'` |
| `src/themes/{backend-sync,classic-skin,persist-accent}.test.*` | Read the default skin from `DEFAULT_SKIN_NAME` instead of hard-coding `'nous'` |
| `src/components/assistant-ui/thread/index.tsx` | Fresh draft shows the `chat.empty` slot (the Athena splash) instead of core's intro. Not in D05's list: `chat.empty` only mounts for existing sessions, so the splash could not reach the launch screen otherwise |
| `src/plugins/athena-brand/plugin.tsx` | New: one-line re-export that joins the bundled-plugin glob |
| `product-identity.d.cts` | Optional `copyright` field (Athena variant only) |
| `package.json` | `author: "SickKids"`, `copyright` crediting Hermes Agent (MIT) |
| `electron-builder.config.cjs` | Athena `copyright` and Linux maintainer from `branding.json` |
| `electron/main.ts` | About panel copyright from the identity (two places) |
| `scripts/set-exe-identity.mjs` | Windows exe name, company and copyright from `branding.json` for the Athena variant |
| `src/components/onboarding/providers.tsx` | `sortProviders` drops hidden (Nous) providers: the choke point for every OAuth provider list |
| `src/components/onboarding/index.tsx` | No featured Nous row on the key form; custom-endpoint docs link → `supportUrl` |
| `src/app/settings/constants.ts` | Hidden provider key groups filtered (Nous Portal) |
| `src/lib/docs.ts`, `src/lib/error-surface.ts`, `src/app/chat/sidebar/section-states.tsx`, `src/components/version-details.tsx` | Docs / support / commit links → `supportUrl` |

## Managed client (F02)

The managed client (F02) narrows what Settings, the pickers and the backend
calls offer, per role, from an admin-signed client config. Its code lives in
`src/athena/managed/` (renderer) and `electron/athena/` (main), with small
hooks into upstream files. Every hook is a no-op until a later slice installs
a real filter.

- `managed/features.ts`: the feature filter (`$featureFilter`, allow-all by
  default). `setFeatureFilter` installs one; `useFeatureFilter` subscribes.
- `managed/settings-entries.ts`: the stable entry ids every Settings list is
  filtered by, and one helper per list. Ids: `settings:<view>` for a page
  (`?tab=`), `settings:<view>/<page>` for a subpage or sub-view
  (`?page=`, `?pview=`, `?kview=`, `?bview=`), `config-field:<key>` for a
  config field, and the search rows' own ids (`setting:<view>.<kebab>`,
  `credential:<KEY>`, `plugin:desktop:<id>`, `plugin:agent:<key>`). A denied
  page takes its children, fields and search rows with it.
- Seams that refuse, not just hide (allow-all today):
  - REST, IPC and deep links in main: `electron/athena/policy-seams.ts`
    (`setMainPolicySeams`). A refused REST call resolves a sentinel that
    preload rethrows as `refused_by_policy: rest <METHOD> <path>`; a refused IPC
    channel is never registered (`GUARDED_IPC_CHANNELS`: plugin install,
    Hermes Cloud, updates; web access is REST only); a refused deep link is
    dropped with a log line.
  - JSON-RPC in the renderer: `managed/rpc-seam.ts` (`setRpcPolicy`), asked
    first by `HermesGateway.request`, so desktop plugins' `host.request` and
    `requestProfile` pass it too. The renderer dials the gateway's `/api/ws`
    itself; main only mints the one-use ticket, so main never sees JSON-RPC.
  - `managed/policy-refusal.ts`: `PolicyRefusedError` (`code`, `kind`,
    `target`); `PolicyRefusedError.from(error)` reads a bridged REST refusal.
- `managed/models.ts`: the one model-options selector. Every picker (composer
  menu, picker dialog, Edit Models, the Settings model selects) lists
  `modelPickerProviders(catalog, customModels)` (catalog plus remembered custom
  ids) and offers `modelPickerCustomCandidate` as its typed-id row;
  `/model <id>` asks `isModelSelectable`. The policy (`setModelPolicy`:
  `selectable` per model, `customIds` on/off) allows everything today.
  `allowsCustomModelIds` is the switch for the "Add custom model…" /
  "Custom model…" entries, which still show unconditionally.
  `model-selector-scope.test.ts` fails if a UI file merges custom ids itself.

- The signed client config (slice 14):
  - Electron main (`electron/athena/client-config.ts`) reads
    `$HERMES_HOME/athena/client-config.jws` (stored by `athena config sync`)
    and re-verifies it with the bundled keys (`electron/athena/bundled-config-data.ts`, a copy of athena's `trusted-keys.json`):
    signature, `typ: athena-client-config+jws`, `aud: athena-desktop`, the
    schema major, `sub` = the signed-in `oid` (from `token.json`: an `oid` key,
    else the access token's `oid` claim) and no `config_version` below the
    highest seen. A bad file keeps the last good copy (until 7 days past its
    expiry); no file means the bundled default
    (the same file, a copy of `client-config.default.json`). Never the CLI's
    unsigned `client-config.json`.
  - It polls the inputs every second and pushes each new snapshot to every
    window: `athena:client-config:snapshot` (sendSync, read by preload before
    the first paint), `athena:client-config:get` (invoke),
    `athena:client-config:changed` (push). The renderer reads them through
    `window.athenaDesktop.clientConfig` (`electron/athena/preload-bridge.ts`)
    into `managed/client-config.ts` (`$clientConfig`).
  - Main writes `$HERMES_HOME/athena/desktop-status.json`
    (`dev_overrides_active`, `config_version_seen`, `updated_at`) for the
    Shipper's heartbeat. `config_version_seen` is also the replay floor across
    restarts.
  - Dev override: with `ATHENA_DEV_OVERRIDES=1` and a build that is not a
    managed release, `ATHENA_DEV_OVERRIDES_FILE` (default
    `~/athena-demo/athena-overrides.json`) is merged on top (dicts merge, lists
    replace). `ATHENA_MANAGED_RELEASE=1` at build time stamps
    `athenaManagedRelease: true` into the install stamp, and such a build
    ignores the override. The demo build is not a managed release.
  - Settings › About shows "Managed by SickKids · role researcher · config v118 (server)".
  - The bundled copies must match the athena repo
    (`shared/athena_schemas/src/athena_schemas/data/`); `client-config.test.ts`
    compares them when a checkout is present (`ATHENA_REPO`).

- The feature registry (slice 15): `electron/athena/feature-registry.ts`,
  shared by main and the renderer (no imports). One row per line of the
  plan's audit (S01–S124 with the a/b splits): its mark (`keep`, `disable`,
  `remove`), its build default (keep → on, disable → off, remove → no flag,
  always off) and the entry ids that reach it: `settings:<view>[/<page>]`,
  `config-field:<key>`, `setting:<view>.<kebab>`, `credential:<KEY>`,
  `settings-control:<name>` (an id ending in `*` is a prefix). An entry stays
  while any row listing it is on; an entry no row lists is left alone.
  - Flags: build default < bundled default config < server config < dev
    override; main layers the documents, `featureStates(config)` reads
    `features` (exceptions, `"on"`/`"off"`). `managed.features: report` and
    `off` turn filtering off (remove rows stay off); see slice 19 below.
  - `managed/feature-policy.ts` installs `featureEntryFilter(config)` as the
    feature filter on every `$clientConfig` change (build defaults until the
    first snapshot, and on hosts with no Electron bridge).
  - In-page rows: `managed/hidden-rows.ts` hides refused `setting:` and
    `credential:` rows by their DOM ids (`setting-field-…`,
    `credential-key-…`) with one `<style>`; controls with no id use
    `managed/feature-gate.tsx` (`<FeatureGate entry="settings-control:…">`) or
    `useFeatureEntry`.
  - Route guard: `managed/settings-route-guard.ts` sends a refused `?tab=`
    (or a refused `page`, sub-view, `field`, `setting` or `key`) to the
    Settings home with a quiet notice; a page whose default sub-view is refused
    opens its first allowed child (Providers → Local models).
  - Export: `electron/athena/features.json` (`{schema_version, source,
    features: [{id, mark, default, area, title}]}`) is generated from the
    registry; `feature-registry.test.ts` fails when it is stale
    (`ATHENA_WRITE_FEATURES=1` rewrites it), when the athena copy
    (`shared/athena_schemas/src/athena_schemas/data/features.json`) differs, or
    when a mark differs from the plan's audit table (with the OKF bundle
    present, `ATHENA_OKF`). The admin API refuses unknown ids and remove rows
    with 422.
  - `managed/settings-registry.test.tsx` drives every Settings row through
    the real nav, palette, search, field lists, in-page rows and route guard.
  - `client-config.e2e.test.ts` (opt-in, `ATHENA_E2E=1`) runs admin API →
    `athena config sync` → main's verifier → filter on the compose stack.

- Entry points outside Settings (slice 16) use the same registry and filter,
  with more entry kinds: `keybind:<action>`, `route:<path>`,
  `command-center:<tab|button>`, `palette:<row id>`, `statusbar:<item id>`,
  `nav:<sidebar row>`, `slash:<command>`, `error-action:<id>`,
  `deep-link:<kind>`, `plugin:<id>`, `pane:<id>`, `dialog:<name>`.
  - `electron/athena/app-locations.ts` (pure, shared): the entries an in-app
    path or an OS deep link reaches (`/settings?…` → the Settings entries,
    `/cron` → `route:/cron`, `/command-center?section=usage` →
    `command-center:usage`, `hermes://<kind>/…` → `deep-link:<kind>`).
  - Main: `electron/athena/main-policy.ts` installs the deep-link seam on every
    snapshot; `handleDeepLink` drops a refused link with
    `[deeplink] refused by policy`.
  - Renderer: `managed/entry-points.ts` (shortcuts, open targets, palette,
    status bar, slash commands, error-card buttons, toast buttons) and
    `managed/entry-point-guards.ts` (the app route guard, the sidebar rows
    through core's `sidebarNav.prefs` area, the terminal pane, flagged bundled
    plugins: Bot Mode stays listed but off).
  - A refused slash command answers "Not available in Athena." and is not
    offered in the popover; a refused shortcut drops out of Settings ›
    Keyboard Shortcuts and its chord does nothing.
  - `managed/entry-points.test.tsx` drives every such row off and on, the
    deep links, toasts, slash replies, Bot Mode and the terminal, and holds a
    tripwire on each upstream hook.

- The curated catalog in Capabilities (slice 28): while `managed.tools` is
  `enforce` or `report`, `CapabilitiesView` renders `catalog/catalog-page.tsx`
  instead of the Skills, Plugins, Connectors and Toolsets tabs (`off`, or no
  client config at all, keeps the stock page).
  - `catalog/catalog.json` is a byte copy of athena's
    `client/catalog/catalog.json`; `catalog-bundle.test.ts` compares them when
    a checkout is present (`ATHENA_REPO`). Re-copy it after
    `athena-build-catalog`.
  - Cards are the config's `tools.available` (in that order, grouped by the
    entry's `group`): title, version, summary, the "Sends:" line from
    `permissions.data`, and a switch. `locked_on` entries and entries with
    `user_toggle: false` say "Managed" with no switch; `status: experimental`
    shows a badge. On/off mirrors the applier (`tool_pins.is_on`).
  - A switch calls `window.athenaDesktop.tools.set(id, on)` →
    `athena:tool-prefs:set` → `electron/athena/tool-prefs.ts`, which runs
    `athena config tool <id> on|off` (writes `$HERMES_HOME/athena/tool-prefs.json`
    and re-applies managed scope), one toggle at a time. The CLI is
    `ATHENA_CLI` (the dev launcher sets it), else `athena` on the PATH the app
    was launched with (captured before the login-shell PATH merge). With no CLI,
    main writes the file in the CLI's format and the next sync applies it.
    `athena:tool-prefs:get` reads the file.
  - Learned skills (`catalog/learned-skills.tsx`): local skills that managed
    scope leaves on and the catalog did not install, viewed through
    `/api/skills/content` and deleted with the stock archive
    (`DELETE /api/learning/node`). No add, import, URL or editor.
  - "Ask Research IT" shows only when the config has `tools.request_url`.

- Backend refusals (slice 17): a disabled feature is refused, not just
  hidden. Rows also list their backend surfaces: `rest:<path>`,
  `rest:<METHOD> <path>` and `rest:WRITE <path>` (any method but GET/HEAD),
  `rpc:<method>` and `rpc:<method>/<action>` (the `config.set` key, a
  `*.manage` action, the `command.dispatch` name), `ipc:<channel>`,
  `env:<KEY>` (an /api/env write of a key no `credential:` entry names) and
  `devtools:open`. `electron/athena/backend-policy.ts` (pure, shared) turns a
  call into the entries it reaches and decides it with the same flags.
  - Main (`main-policy.ts`, every snapshot): `hermes:api` refuses a REST call
    reaching a refused entry; a refused IPC channel is unregistered and comes
    back when its row turns on (`policy-seams.ts` tracks every registration of
    an `ipc:` channel: `guardedIpcMain`, or any `ipcMain.handle`/`on` once
    `ipc-guard-install.ts`, the first import of `main.ts`, wrapped
    `ipcMain`); DevTools (S65) do not open from F12, the inspect chord or the
    View menu item (hidden, rebuilt on change), and DevTools opened any other
    way close again.
  - Always refused, in every mode: `PUT`/`DELETE /api/env` of
    `HERMES_MANAGED_DIR`, `HERMES_MANAGED`, `HERMES_HOME`,
    `PYTEST_CURRENT_TEST` and any `ATHENA_*` variable (spike 05: the app's own
    env editor could unpin the running daemon).
  - Renderer (`managed/feature-policy.ts`): the JSON-RPC seam refuses a
    method or action reaching a refused entry, so a desktop plugin's
    `host.request` is refused too; `command.dispatch` / `slash.exec` also ask
    `slash:<command>`.
  - Config keys: `features.json` exports each row's `config_keys` (its
    `config-field:` entries; `*` is a prefix). `athena config apply` pins the
    keys of every row that is off in managed scope, at the Athena value, so
    Import config, Reset to defaults and hand-made `PUT /api/config` cannot
    change them; a row turned on is unpinned on the next sync.
  - Desktop settings a row pins (`managed/desktop-pins.ts`): S36 holds inline
    embeds at `off`; S87 refuses `hermes:secret-storage:set`; S65 is DevTools.
  - Refusals are appended to `$HERMES_HOME/athena/policy-decisions.jsonl`
    (`policy-decisions.ts`; the renderer sends its own over
    `athena:policy-decision`).
  - Tests: `electron/athena/backend-policy.test.ts` and
    `managed/backend-refusal.test.tsx` send every surface of every row that is
    off by default (off → refused, on → through, remove → refused even "on").

- Removed features (slice 18): the 22 `remove` rows are left out of the Athena
  variant. A remove row has no flag: `featureStates` keeps it off whatever the
  server config, the dev override or `managed.features: off` say (main logs
  `features.<id> = "on" ignored`; the admin API refuses it with 422). Its UI is
  not mounted (pages, controls and dialogs ask their entry: stock onboarding,
  the free-tier dialog, notice strip and terms bar, the usage-stats consent,
  Hermes Cloud in the mode control, the diagnostics upload, "Check now",
  Advanced Delegation's install), its IPC handlers are not registered, and its
  REST, JSON-RPC and config keys are refused and pinned as in slice 17.
  Opening Settings no longer reads `billing.state` / `subscription.state`.
  - **Bringing a removed feature back** is a registry change and a build:
    change the row's mark in `electron/athena/feature-registry.ts` from
    `remove` to `disable` (or `keep`), regenerate `features.json`
    (`ATHENA_WRITE_FEATURES=1`) and copy it to athena, update the plan's audit
    table (the mark test reads it), rebuild. No upstream code was deleted.
  - Variant-gated: `electron/athena/variant.ts` tells the Athena variant (the
    install stamp's `brand: "athena"`, or the baked `ca.sickkids.athena` app
    id) from a stock build. In a stock build every snapshot says
    `variant: "stock"` and the managed client is inert: allow-all filter,
    JSON-RPC and main seams, no pins.
  - Startup egress: `managed/nous-egress.test.ts` classifies every main and
    renderer source naming a Nous host and checks each fetch is shut in the
    Athena variant; athena's `tests/hook_sequence/test_egress.py` runs the
    gateway daemon headless with a socket audit hook through a connected chat
    and a Settings walk and sees only loopback.
  - Tests: `managed/removed-features.test.tsx`.

- Master switches and report mode (slice 19): `managedMode(config, area)`
  (`electron/athena/feature-registry.ts`) reads `managed.features`,
  `managed.models` and `managed.tools` (`enforce` | `report` | `off`; missing
  or unknown is `enforce`), for slices 20 and 27 too. For features:
  - `enforce`: hide and refuse (slices 15-18), and record each refusal;
  - `report`: hide and refuse nothing (remove rows stay out), pin nothing
    (`athena config apply` pins only remove rows), and record each *use* of a
    feature an `enforce` config would refuse as `allowed_in_report`;
  - `off`: stock behaviour for features, nothing recorded.
  - A list (nav, palette, search, the key map, card buttons) asks the
    visibility filter; a use asks the decider: REST, IPC (each invoke of a
    tracked channel), DevTools and deep links in main; JSON-RPC, slash
    commands, shortcuts and page opens (the route guards) in the renderer
    (`managed/feature-use.ts`, `decideUse`). Slash suggestions are a list
    (`isSlashCommandOffered`).
  - Records: Electron main appends one JSON line per decision to
    `$HERMES_HOME/athena/policy-decisions.jsonl`:
    `{"ts", "source": "desktop", "kind": "feature", "id": <row>, "action":
    "refused"|"allowed_in_report", "mode", "surface", "target"}` (the renderer
    sends its own over `athena:policy-decision`; main validates and stamps
    them). The same feature decision within 5 s is written once (one use
    crosses several surfaces; pages poll), a refusal once per 10 min (the
    stock app polls some refused methods in the background). Past 1 MiB the
    file starts over.
    The athena Shipper tails it into `athena:policy_decision` events
    (`athena_guard` writes the same file with `source: "guard"`).
  - Tests: `electron/athena/report-mode.test.ts`, `managed/report-mode.test.tsx`;
    `managed/settings-lists.test.tsx` checks that with every master switch
    `off` the Settings nav and palette equal the D05 lists less the removed
    features.

### Upstream files touched (F02)

Keep the F02 diff to these, plus `src/athena/**` and `electron/athena/**`.
`managed/diff-scope.test.ts` fails when the branch touches anything else
(paths are relative to `apps/desktop/`; the base is `feature/athena-demo`,
override with `ATHENA_F02_BASE`).

| File | Change |
|---|---|
| `src/app/settings/index.tsx` | Nav groups go through `filterSettingsNav`; subpage children read the live filter; the Athena route guard; Export / Import / Reset ask the filter |
| `src/app/settings/subpages.ts` | `settingsSubpages` (every subpage registry) asks the filter |
| `src/app/settings/helpers.ts` | `sectionFieldEntries` (config section field lists, page and search) asks per field |
| `src/app/settings/use-settings-search.ts` | Every settings-search list goes through `allowedSettingsSearchEntries` |
| `src/app/command-palette/index.tsx` | Settings rows (root and Settings page) ask the filter |
| `electron/main.ts` | `hermes:api` asks the REST seam first; `handleDeepLink` asks the deep-link seam before routing; Hermes Cloud and updates channels register through `guardedIpcMain` |
| `electron/fs-ipc.ts` | Plugin install channels (`hermes:plugin:probe`, `hermes:plugin:installDesktop`) register through `guardedIpcMain` |
| `electron/preload.ts` | `api` turns a REST refusal sentinel into the rejection (`unwrapPolicyRefusal`) |
| `src/api/client.ts` | `HermesGateway.request` asks the JSON-RPC seam first |
| `src/app/shell/model-catalog-menu.tsx` | Composer model menu rows and its typed-id row come from the model-options selector |
| `src/components/model-picker.tsx` | Model picker dialog rows and its typed-id row come from the selector |
| `src/components/model-visibility-dialog.tsx` | Edit Models rows and its typed-id row come from the selector |
| `src/app/settings/model-settings.tsx` | Settings model selects (default model, auxiliary, MoA) read the selector's rows; the Provider row and Speed ask the filter |
| `src/app/settings/fallback-models-field.tsx` | Fallback model rows read the selector |
| `src/app/settings/delegation-model-provider-field.tsx` | Subagent model rows read the selector |
| `src/app/session/hooks/use-prompt-actions/slash.ts` | `/model <id>` asks `isModelSelectable` before running on the backend |
| `electron/main.ts` | Installs the Athena client config (`installAthenaClientConfig`) before the guarded channels register |
| `electron/preload.ts` | Exposes `window.athenaDesktop` (`exposeAthenaBridge`) |
| `src/main.tsx` | Imports `athena/managed/boot` (follow main's client config) before the first render |
| `src/app/settings/about-settings.tsx` | The "Managed by SickKids · role … · config v…" line under the version; update channel, backend update card and inline Uninstall ask the filter |
| `scripts/write-build-stamp.mjs` | `ATHENA_MANAGED_RELEASE=1` stamps `athenaManagedRelease: true` (no dev overrides) |
| `src/app/settings/profile-scope.tsx` | The "Applies to" chips ask the filter (S04) |
| `src/app/settings/config-settings.tsx` | Run onboarding again (S68) and Share usage stats (S49) ask the filter |
| `src/app/settings/appearance-settings.tsx` | Marketplace theme results (S24) ask the filter |
| `src/app/hooks/use-keybinds.ts` | A refused shortcut (`keybind:<id>`) does nothing, from a chord or a plugin's `runAction` |
| `src/app/settings/keybind-settings.tsx` | Refused shortcuts drop out of the key map |
| `src/lib/hermes-open-target.ts` | `resolveHermesOpenPath` resolves a refused in-app path to nothing |
| `src/app/shell/hooks/use-overlay-routing.ts` | The Athena app route guard (refused page → new chat) |
| `src/app/shell/hooks/use-statusbar-items.tsx` | Status-bar items go through `allowedStatusbarItems` |
| `src/app/command-palette/index.tsx` | Palette groups go through `allowedPaletteGroups` (row id and its shortcut) |
| `src/app/session/hooks/use-prompt-actions/slash.ts` | A refused slash command answers "Not available in Athena." |
| `src/lib/desktop-slash-commands.ts` | Refused slash commands are not suggested |
| `src/components/assistant-ui/thread/assistant-message.tsx` | Error-card buttons into refused features are not offered |
| `src/store/notifications.ts` | Recovery buttons are tagged with what they open; refused ones are left off the toast |
| `src/app/command-center/index.tsx` | Command Center tabs and the Restart / Update buttons ask the filter |
| `src/contrib/plugins-store.ts` | A plugin the policy refuses (`plugin:<id>`) never activates; `pluginPolicyHandle` for live switching |
| `src/app/right-sidebar/terminal/reveal-focus.ts` | The terminal pane opens only while `pane:terminal` is allowed |
| `src/store/profile.ts` | `requestProfileCreate` asks the filter |
| `src/store/profile-share.ts` | `runImportProfileFlow` asks the filter |
| `src/app/profiles/create-profile-dialog.tsx` | The create/import dialog opens only while allowed |
| `src/store/send-diagnostics.ts` | `requestSendDiagnostics` asks the filter |
| `src/app/capabilities/index.tsx` | `CapabilitiesView` renders the Athena catalog page while `managed.tools` is enforce or report; the stock view is `StockCapabilitiesView`, unchanged (slice 28) |
| `electron/main.ts` | Installs the Capabilities tool switches (`installAthenaToolPrefs`, `athena:tool-prefs:get`/`set`) (slice 28) |
| `electron/main.ts` | Imports `athena/ipc-guard-install` first (policy IPC channels follow the flags); `toggleDevTools`, `devtools-opened` and the View menu's DevTools item ask the DevTools seam; the menu is rebuilt on a policy change (slice 17) |
| `src/app/settings/config-field.tsx` | `ConfigField` returns `athenaConfigField(…)` when it gives a control: Max agent steps (`agent.max_turns`) takes 10 to the role's `models.max_turns_limit` (`managed/max-turns-field.tsx`, slice 24) |
| `src/app/contrib/wiring.tsx` | Stock onboarding (S109) is not decided or mounted; the usage-stats consent (S49) and free-tier sign-in (S110) dialogs are not mounted (slice 18) |
| `src/app/contrib/controller.tsx` | The free-tier terms bar asks `dialog:portal-terms` (S110, slice 18) |
| `src/app/chat/composer/status-stack/index.tsx` | The free-tier notice and usage-stats consent strips ask the filter (S110, S49, slice 18) |
| `src/app/settings/gateway-settings.tsx` | Each connection-mode card asks its entry; Hermes Cloud (S84) is not offered (slice 18) |
| `src/app/settings/delegation/routing-section.tsx` | Routing follows S13; Advanced Delegation's catalog install (S14) is not offered (slice 18) |
| `src/components/update-status.tsx` | "Check now" asks `settings-control:updates-check-now` (S69/S105, slice 18) |
| `src/app/update-error-report.tsx` | The diagnostics upload to Nous is not offered (S117, slice 18) |
| `src/components/error-boundary.tsx` | The crash screen's Send diagnostics is not offered (S117, slice 18) |
| `src/components/assistant-ui/thread/assistant-message.tsx` | The error card's Send diagnostics is not offered (S117, slice 18) |
| `src/app/settings/index.tsx` | `billing.state` / `subscription.state` are read only while Billing is allowed (S77, slice 18) |
| `src/lib/desktop-slash-commands.ts` | Slash suggestions ask `isSlashCommandOffered` (a list, not a use: nothing recorded) (slice 19) |
