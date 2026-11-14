// Athena (R01 slice 26): the first import of ipc-guard-install.ts, itself the first import of main.ts, for its
// side effect. A Desktop binary opened directly from inside an install root starts the launcher and exits here,
// before main sets user data, takes the single-instance lock, registers a channel or starts a backend
// (launcher-handoff.ts says when and why).

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { dialog } from 'electron'

import { type HandoffCommand, handoffPlan, LAUNCHER_MISSING_BODY, LAUNCHER_MISSING_TITLE } from './launcher-handoff'

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function stamp(): string {
  const now = new Date()
  const two = (value: number) => String(value).padStart(2, '0')

  return (
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
  )
}

function note(file: null | string, text: string): void {
  if (!file) {
    return
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${stamp()} ${text}\n`)
  } catch {
    // The log is a convenience; the hand-off does not depend on it.
  }
}

/** A launcher the icon (or an earlier direct launch) started and that has not become the app yet (macOS). */
function launcherAlreadyStarting(pidFile: null | string): boolean {
  if (!pidFile) {
    return false
  }

  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)

    if (!Number.isInteger(pid) || pid <= 1) {
      return false
    }

    const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 })

    return command.includes('athena-desktop.sh')
  } catch {
    return false
  }
}

function start(run: HandoffCommand): void {
  let out: 'ignore' | number = 'ignore'

  if (run.logFile) {
    fs.mkdirSync(path.dirname(run.logFile), { recursive: true })
    out = fs.openSync(run.logFile, 'a')
  }

  const child = spawn(run.command, run.args, {
    detached: true,
    env: run.env,
    stdio: ['ignore', out, out],
    windowsHide: true
  })

  child.on('error', () => undefined)

  if (run.pidFile && child.pid) {
    try {
      fs.mkdirSync(path.dirname(run.pidFile), { recursive: true })
      fs.writeFileSync(run.pidFile, `${child.pid}\n`)
    } catch {
      // Only the icon's "already starting" check reads it.
    }
  }

  child.unref()
}

const plan = handoffPlan({ env: process.env, execPath: process.execPath, isFile, platform: process.platform })

if (plan.kind === 'handoff') {
  if (launcherAlreadyStarting(plan.run.pidFile)) {
    note(plan.run.noteFile, 'the app was opened directly while the launcher is starting; left to the launcher')
    process.exit(0)
  }

  try {
    start(plan.run)
    note(plan.run.noteFile, `the app was opened directly; starting ${plan.launcher}`)
    process.exit(0)
  } catch (error) {
    note(plan.run.noteFile, `the app was opened directly and the launcher did not start: ${String(error)}`)
    dialog.showErrorBox('Athena could not start', 'Open Athena from the Athena icon, or run the Athena installer again.')
    process.exit(1)
  }
} else if (plan.kind === 'launcher-missing') {
  dialog.showErrorBox(LAUNCHER_MISSING_TITLE, LAUNCHER_MISSING_BODY)
  process.exit(1)
}
