// Athena (R01 slice 26): what a launch of the Desktop binary does when it was not started by the launcher.
//
// An installed Athena is started by its launcher (athena: client/installer, `athena-desktop.sh` / `.ps1`), which
// gives the app the Profile (`HERMES_HOME`), its own user data folder, managed scope, the pinned hermes and the
// server addresses. Opened directly (the Dock icon the running app leaves behind, a taskbar pin, a double click on
// the bundle) the same binary has none of that: it runs on the user's own hermes home with no gateway model, no
// capture, no guard and no managed scope, and Electron's default user data folder for an app named Athena is the
// install root itself. So a direct launch from inside an install root starts the launcher and exits, before
// anything else in main runs.
//
// Pure: no electron or node imports, so the decision is tested without a process. The side effects (spawn, dialog,
// exit) are in launcher-handoff-install.ts, which runs before anything else in main.ts.

export type HandoffPlatform = 'darwin' | 'win32' | (string & {})

export interface HandoffInputs {
  platform: HandoffPlatform
  /** `process.execPath`: the app binary. */
  execPath: string
  env: Readonly<Record<string, string | undefined>>
  /** Whether a path names an existing file. */
  isFile: (path: string) => boolean
}

export interface HandoffCommand {
  command: string
  args: string[]
  /** The whole environment of the launcher process. */
  env: Record<string, string>
  /** Where the launcher's output goes (the launcher's own log); none on Windows, where it logs by itself. */
  logFile: null | string
  /** The icon's "already starting" record (macOS). */
  pidFile: null | string
  /** A line for the icon's log saying why the launcher started. */
  noteFile: null | string
}

export type HandoffPlan =
  | { kind: 'none' }
  | { kind: 'handoff'; root: string; launcher: string; run: HandoffCommand }
  | { kind: 'launcher-missing'; root: string; launcher: string }

/** The variables every launcher start gives the app; a process that holds them was started by a launcher. */
const LAUNCHER_MARKS = ['HERMES_HOME', 'HERMES_DESKTOP_USER_DATA_DIR'] as const

export function launchedByLauncher(env: HandoffInputs['env']): boolean {
  return LAUNCHER_MARKS.every(name => Boolean(env[name]))
}

const sepOf = (platform: HandoffPlatform): string => (platform === 'win32' ? '\\' : '/')

function parentOf(path: string, sep: string): string {
  const at = path.lastIndexOf(sep)

  return at <= 0 ? '' : path.slice(0, at)
}

const nameOf = (path: string, sep: string): string => path.slice(path.lastIndexOf(sep) + 1)

/** The folders the installers unpack the Desktop into, under the install root (`app` links to `app.noindex`). */
const APP_FOLDERS = new Set(['app', 'app.noindex'])

/**
 * The install root this binary sits in, or null: the nearest ancestor folder named `app` or `app.noindex` whose
 * parent holds the install's `settings.json`.
 *
 * macOS: `<root>/app.noindex/Athena.app/Contents/MacOS/Athena`; Windows: `<root>\app\Athena\Athena.exe`. A dev
 * bundle (`release/mac-arm64/Athena.app`) and a stock install are in no such folder.
 */
export function installRootOf({ execPath, isFile, platform }: Pick<HandoffInputs, 'execPath' | 'isFile' | 'platform'>): null | string {
  const sep = sepOf(platform)
  let folder = parentOf(execPath, sep)

  for (let depth = 0; depth < 6 && folder; depth += 1) {
    const root = parentOf(folder, sep)

    if (APP_FOLDERS.has(nameOf(folder, sep)) && root && isFile(`${root}${sep}settings.json`)) {
      return root
    }

    folder = parentOf(folder, sep)
  }

  return null
}

function darwinCommand(root: string, launcher: string, env: HandoffInputs['env']): HandoffCommand {
  // The launcher builds the app's environment itself (`env -i`), so it gets the basics and the install root only:
  // nothing of whatever started this process (a VS Code shell's ELECTRON_RUN_AS_NODE, vendor API keys).
  const launcherEnv: Record<string, string> = { ATHENA_INSTALL_ROOT: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

  for (const name of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']) {
    const value = env[name]

    if (value) {
      launcherEnv[name] = value
    }
  }

  return {
    args: [launcher],
    command: '/bin/bash',
    env: launcherEnv,
    logFile: `${root}/logs/desktop.log`,
    noteFile: `${root}/logs/athena-icon.log`,
    pidFile: `${root}/desktop/launcher.pid`
  }
}

function win32Command(root: string, launcher: string, env: HandoffInputs['env']): HandoffCommand {
  const launcherEnv: Record<string, string> = {}

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      launcherEnv[name] = value
    }
  }

  launcherEnv.ATHENA_INSTALL_ROOT = root

  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'

  return {
    // The Start Menu shortcut's own command (athena: client/installer/windows/install-athena.ps1).
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher],
    command: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    env: launcherEnv,
    logFile: null,
    noteFile: null,
    pidFile: null
  }
}

/**
 * What this launch does. `none`: go on as usual (started by a launcher, not in an install root, or a system with
 * no launcher). `handoff`: start the launcher and exit. `launcher-missing`: the install is incomplete; say so and
 * exit, never run unmanaged.
 *
 * A launcher start always carries the launcher's marks, so it is never handed off again: there is no loop.
 */
export function handoffPlan(inputs: HandoffInputs): HandoffPlan {
  const { env, isFile, platform } = inputs

  if (launchedByLauncher(env) || (platform !== 'darwin' && platform !== 'win32')) {
    return { kind: 'none' }
  }

  const root = installRootOf(inputs)

  if (!root) {
    return { kind: 'none' }
  }

  const launcher = platform === 'win32' ? `${root}\\share\\athena-desktop.ps1` : `${root}/share/athena-desktop.sh`

  if (!isFile(launcher)) {
    return { kind: 'launcher-missing', launcher, root }
  }

  const run = platform === 'win32' ? win32Command(root, launcher, env) : darwinCommand(root, launcher, env)

  return { kind: 'handoff', launcher, root, run }
}

/** The dialog of an install whose launcher is gone. */
export const LAUNCHER_MISSING_TITLE = 'Athena is not installed completely'
export const LAUNCHER_MISSING_BODY =
  'Athena starts from the Athena icon, and its launcher is missing. Run the Athena installer again.'
