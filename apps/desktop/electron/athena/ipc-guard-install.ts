// Athena (F02 slices 17 and 29): imported first by main.ts, for its side effect, so every later
// `ipcMain.handle`/`on` of a channel the feature registry lists (`ipc:<channel>`), or of a tool install
// channel (tool-install-policy.ts), is registered only while the policy allows it (policy-seams.ts).

import { ipcMain } from 'electron'

import { isPolicyIpcChannel } from './backend-policy'
import { installIpcPolicyGuard } from './policy-seams'
import { isToolInstallIpcChannel } from './tool-install-policy'

installIpcPolicyGuard(ipcMain, channel => isPolicyIpcChannel(channel) || isToolInstallIpcChannel(channel))
