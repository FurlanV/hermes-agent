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
