// Athena (F02 slice 17): imported first by main.ts, for its side effect, so every later
// `ipcMain.handle`/`on` of a channel the feature registry lists (`ipc:<channel>`) is
// registered only while the policy allows it (policy-seams.ts).

import { ipcMain } from 'electron'

import { isPolicyIpcChannel } from './backend-policy'
import { installIpcPolicyGuard } from './policy-seams'

installIpcPolicyGuard(ipcMain, isPolicyIpcChannel)
