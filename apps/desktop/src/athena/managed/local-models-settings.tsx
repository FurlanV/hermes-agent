/**
 * The status of local models, where the user sees it (F05 slice 08).
 *
 * - Next to each local model in the pickers: connected, connecting, or not connected with the reason. The composer
 *   menu's row badge comes from the model policy (model-policy.ts `rowBadges`); the picker dialog's row gets
 *   `AthenaLocalModelStatus`.
 * - Settings › Model, "Local models" (`AthenaLocalModelsSettings`): the connection's status in full, each local
 *   model's status, Connect or Disconnect (which also forgets the password), and the remembered user name with
 *   Forget.
 *
 * Everything is read from main's bridge status (`$hpcBridge`) and the role's list; main pushes each change, so the
 * words follow the bridge as it goes down and comes back. Nothing shows while local models are off.
 */

import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { ListRow, SectionHeading } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { Network } from '@/lib/icons'

import type { AthenaHpcBridgeApi, HpcBridgeStatus } from '../../../electron/athena/hpc-bridge-types'
import { findModelEntry } from '../../../electron/athena/model-policy'

import { $hpcBridge, offerConnect } from './local-models'
import {
  bridgeStatus,
  canDisconnect,
  localModelOf,
  localModelStatus,
  statusLine,
  statusTag
} from './local-models-status'
import { $managedModels, enforcedModels } from './model-policy'

/** The picker dialog's row: the status after a local model's name (src/components/model-picker.tsx). */
export function AthenaLocalModelStatus({ model, provider }: { model: string; provider: string }) {
  const status = useStore($hpcBridge)
  const found = localModelOf(enforcedModels(useStore($managedModels)), model, provider)

  if (!found) {
    return null
  }

  const local = localModelStatus(found.entry, status, found.callable)

  return (
    <span
      className="shrink-0 font-sans text-[0.62rem] uppercase tracking-wide opacity-80"
      data-athena-local-model-status={local.state}
    >
      {statusTag(local)}
    </span>
  )
}

// ── Settings › Model ────────────────────────────────────────────────────────

export const LOCAL_MODELS_SETTINGS = {
  connect: 'Connect',
  connection: 'Connection to the HPC',
  disconnect: 'Disconnect',
  forget: 'Forget',
  intro:
    'Local models run on the HPC. Athena connects to them from this computer while it is open. Disconnecting also forgets your password; Athena never saves it.',
  title: 'Local models',
  username: 'Remembered HPC username',
  usernameHint: 'Filled in for you the next time you connect. Forgetting it also disconnects.'
} as const

const bridgeApi = (): AthenaHpcBridgeApi | undefined =>
  (window as { athenaDesktop?: { hpcBridge?: AthenaHpcBridgeApi } }).athenaDesktop?.hpcBridge

/** Settings › Model: the "Local models" section. Renders nothing while local models are off for the role. */
export function AthenaLocalModelsSettings() {
  const status = useStore($hpcBridge)
  const models = enforcedModels(useStore($managedModels))
  const [busy, setBusy] = useState(false)

  if (!models || !models.localModels.on || models.localModels.configured.length === 0) {
    return null
  }

  const connection = bridgeStatus(status)
  const signedInAs = connection.state === 'connected' && status?.credential === 'password' && status.username

  const call = (run: (api: AthenaHpcBridgeApi) => Promise<HpcBridgeStatus>) => {
    const api = bridgeApi()

    if (!api || busy) {
      return
    }

    setBusy(true)
    void run(api)
      .then(
        next => $hpcBridge.set(next),
        () => {}
      )
      .finally(() => setBusy(false))
  }

  return (
    <section data-testid="athena-local-models-settings">
      <SectionHeading icon={Network} title={LOCAL_MODELS_SETTINGS.title} />
      <p className="mb-3 text-xs text-muted-foreground">{LOCAL_MODELS_SETTINGS.intro}</p>
      <div className="grid gap-1">
        <ListRow
          action={
            canDisconnect(status) ? (
              <Button disabled={busy} onClick={() => call(api => api.disconnect())} size="sm" variant="outline">
                {LOCAL_MODELS_SETTINGS.disconnect}
              </Button>
            ) : (
              <Button
                disabled={busy || status?.state === 'host_key_unknown'}
                onClick={() => offerConnect()}
                size="sm"
                variant="outline"
              >
                {LOCAL_MODELS_SETTINGS.connect}
              </Button>
            )
          }
          description={
            <span data-testid="athena-local-models-connection">
              {signedInAs ? `${statusLine(connection)} as ${signedInAs}` : statusLine(connection)}
            </span>
          }
          title={LOCAL_MODELS_SETTINGS.connection}
        />
        {models.localModels.configured.map(entry => (
          <ListRow
            action={
              <span className="text-xs text-muted-foreground" data-testid={`athena-local-model-${entry.configId}`}>
                {statusLine(localModelStatus(entry, status, Boolean(findModelEntry(models, entry.id))))}
              </span>
            }
            key={entry.configId}
            title={entry.label}
          />
        ))}
        {status?.username ? (
          <ListRow
            action={
              <Button disabled={busy} onClick={() => call(api => api.forgetUser())} size="sm" variant="outline">
                {LOCAL_MODELS_SETTINGS.forget}
              </Button>
            }
            description={
              <>
                <span data-testid="athena-local-models-username">{status.username}</span>
                {`. ${LOCAL_MODELS_SETTINGS.usernameHint}`}
              </>
            }
            title={LOCAL_MODELS_SETTINGS.username}
          />
        ) : null}
      </div>
    </section>
  )
}
