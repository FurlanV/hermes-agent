// Athena (R02 slice 04): the upstream setup is refused in the Athena build.
//
// A stock Desktop that finds no hermes runs upstream's first-run setup (bootstrap-runner.ts): it downloads an
// install script from raw.githubusercontent.com and clones NousResearch/hermes-agent. Athena is installed by Athena
// Setup, which brings its own pinned hermes, and the build's branch exists only on the fork, so that setup can only
// fail, after talking to GitHub. So while feature row R02 is off (its build default):
// - a start that finds no hermes shows one dialog and exits, before the first-run choice screen, the Windows
//   recovery hand-off or the installer;
// - "Repair install" on the boot-failure screen is refused with the same message, and the app stays open.
// With the row on (a developer's override, or the client config's `features`), and in a stock build, the gate does
// nothing and upstream's setup runs as before.
//
// The row's own flag is asked, not the `managed.features` master switch: `report` or `off` must not open a download
// from GitHub. No electron import: main hands in `app` and `dialog` (upstream-setup.test.ts drives it without them).

import type { App, Dialog } from 'electron'

import { featureStates } from './feature-registry'
import { type DesktopVariant, desktopVariant } from './variant'

/** The feature row that switches upstream's first-run setup and "Repair install" on. */
export const UPSTREAM_SETUP_FEATURE = 'R02'

export const ATHENA_NOT_INSTALLED = 'Athena is not installed on this computer. Run Athena Setup.'

/** Whether this build, under this effective client config, refuses the upstream setup. */
export function upstreamSetupRefused(variant: DesktopVariant, config: unknown): boolean {
  return variant !== 'stock' && !featureStates(config).flag(UPSTREAM_SETUP_FEATURE)
}

/** Thrown after the exit is asked for, so the start that reached the setup goes no further while the app closes. */
export class UpstreamSetupRefusedError extends Error {
  constructor() {
    super(ATHENA_NOT_INSTALLED)
    this.name = 'UpstreamSetupRefusedError'
  }
}

export interface UpstreamSetupGateOptions {
  app: Pick<App, 'exit'>
  /** The baked identity's app id: an unstamped dev bundle is told apart by it (variant.ts). */
  appId?: string
  /** The effective client config (undefined before it is installed: the build defaults then stand). */
  config: () => unknown
  dialog: Pick<Dialog, 'showMessageBoxSync'>
  flushLog: () => void
  installStamp: unknown
  log: (line: string) => void
  /** Default: from the install stamp and the app id. */
  variant?: DesktopVariant
}

export interface UpstreamSetupGate {
  /**
   * Call where a start would go on to the upstream setup. Refused: one dialog, exit code 1, and a throw. Otherwise
   * it returns and the caller goes on.
   */
  exitIfRefused: (reason: string) => void
  /**
   * The backend a start resolved, handed back unchanged. One that needs the upstream setup (`bootstrap-needed`) is
   * refused here, before the first-run choice screen is shown.
   */
  resolved: <Backend extends { kind?: unknown }>(backend: Backend) => Backend
  /** The answer of `hermes:bootstrap:repair` when repair is refused (the renderer shows `error`), or null. */
  repairRefusal: () => { error: string; ok: false } | null
}

export function createUpstreamSetupGate(options: UpstreamSetupGateOptions): UpstreamSetupGate {
  const variant = options.variant ?? desktopVariant(options.installStamp, options.appId)
  const refused = () => upstreamSetupRefused(variant, options.config())

  const exitIfRefused = (reason: string) => {
    if (!refused()) {
      return
    }

    options.log(`[athena] upstream setup refused (${reason}; feature ${UPSTREAM_SETUP_FEATURE} is off); exiting`)
    options.flushLog()
    options.dialog.showMessageBoxSync({ buttons: ['OK'], message: ATHENA_NOT_INSTALLED, noLink: true, type: 'error' })
    options.app.exit(1)

    throw new UpstreamSetupRefusedError()
  }

  return {
    exitIfRefused,
    resolved: backend => {
      if (backend.kind === 'bootstrap-needed') {
        exitIfRefused('no hermes found at startup')
      }

      return backend
    },
    repairRefusal: () => {
      if (!refused()) {
        return null
      }

      options.log(`[athena] repair install refused (feature ${UPSTREAM_SETUP_FEATURE} is off)`)

      return { error: ATHENA_NOT_INSTALLED, ok: false }
    }
  }
}
