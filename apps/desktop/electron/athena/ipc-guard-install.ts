// Athena (F02 slices 17 and 29): imported first by main.ts, for its side effect, so every later
// `ipcMain.handle`/`on` of a channel the feature registry lists (`ipc:<channel>`), or of a tool install
// channel (tool-install-policy.ts), is registered only while the policy allows it (policy-seams.ts).

// R01 slice 26: before all of that, a binary opened without its launcher hands the launch over and exits
// (launcher-handoff-install.ts). It is this module's first import, so it runs before anything else in main.
import './launcher-handoff-install'

import { ipcMain } from 'electron'

import { isPolicyIpcChannel } from './backend-policy'
import { installIpcPolicyGuard } from './policy-seams'
import { isToolInstallIpcChannel } from './tool-install-policy'

installIpcPolicyGuard(ipcMain, channel => isPolicyIpcChannel(channel) || isToolInstallIpcChannel(channel))
