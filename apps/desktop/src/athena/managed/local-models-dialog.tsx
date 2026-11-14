/**
 * The sign-in dialog for local models (F05 slice 07).
 *
 * Shown when the user picks a local model and Electron main holds nothing to sign in to the HPC with. It says what
 * the connection is for, asks for the HPC user name and password, and says the password is kept only while Athena
 * is open and is never saved.
 *
 * The password lives in this component's state only while the dialog is open. On Connect it is taken out of the
 * field and handed to main once (`signInToLocalModels`); the field is empty from that moment, whatever main
 * answers. Closing the dialog unmounts the form. Nothing here writes it to a store, to storage or to a log.
 */

import { useStore } from '@nanostores/react'
import { type FormEvent, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { notify } from '@/store/notifications'

import {
  $hpcBridge,
  $localModelsDialog,
  closeLocalModelsDialog,
  connectFailure,
  type HpcBridgeStatus,
  signInToLocalModels
} from './local-models'

export const LOCAL_MODELS_DIALOG = {
  cancel: 'Cancel',
  connect: 'Connect',
  connecting: 'Connecting…',
  intro:
    'Local models run on the HPC. To use them, Athena signs in to the HPC from this computer with your HPC account.',
  password: 'HPC password',
  passwordKept: 'Your password is kept only while Athena is open and is never saved.',
  title: 'Connect to local models',
  username: 'HPC username'
} as const

/** What the dialog says when a sign-in did not go through, by main's reason. */
export const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  auth_failed: 'The HPC did not accept that username and password. Check them and try again.',
  auth_unsupported: 'The HPC asked for more than a password, which Athena cannot answer. Contact your administrator.',
  connection_lost: 'Athena could not reach the HPC login node. Check your network connection and try again.',
  host_key_mismatch:
    'Athena could not confirm it was talking to the HPC login node, so your password was not sent. Contact your administrator.',
  host_key_unknown: 'This version of Athena cannot connect to local models. Contact your administrator.',
  timeout: 'Athena could not reach the HPC login node. Check your network connection and try again.',
  unreachable: 'Athena could not reach the HPC login node. Check your network connection and try again.'
}

export const SIGN_IN_FAILED = 'Athena could not connect. Try again.'
export const SIGN_IN_OFF = 'Local models are turned off.'
export const MODEL_SERVER_DOWN = 'Connected to the HPC, but the model server is not answering. Athena will keep trying.'
export const LOCAL_MODELS_CONNECTED = 'Local models are connected.'

export function signInError(status: HpcBridgeStatus | null): null | string {
  const failure = connectFailure(status)

  if (failure === null) {
    return null
  }

  return status?.state === 'off' ? SIGN_IN_OFF : (SIGN_IN_ERRORS[failure] ?? SIGN_IN_FAILED)
}

function SignInForm() {
  const remembered = useStore($hpcBridge)?.username ?? ''
  const [username, setUsername] = useState(remembered)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const ready = username.trim() !== '' && password !== '' && !busy

  async function submit(event: FormEvent) {
    event.preventDefault()

    if (!ready) {
      return
    }

    // The password leaves the field now and goes to main once; nothing in this window keeps it.
    const signIn = { password, username: username.trim() }
    setPassword('')
    setBusy(true)
    setError(null)

    const status = await signInToLocalModels(signIn)
    signIn.password = ''

    const failed = signInError(status)

    if (failed) {
      setBusy(false)
      setError(failed)
      passwordRef.current?.focus()

      return
    }

    const servers = Object.values(status?.servers ?? {})
    const noServer = servers.length > 0 && servers.every(server => server.state === 'down')

    notify({
      id: 'athena-local-models',
      kind: noServer ? 'warning' : 'success',
      message: noServer ? MODEL_SERVER_DOWN : LOCAL_MODELS_CONNECTED
    })
    closeLocalModelsDialog()
  }

  return (
    <form className="grid gap-4" data-testid="athena-local-models-form" onSubmit={event => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{LOCAL_MODELS_DIALOG.title}</DialogTitle>
        <DialogDescription>{LOCAL_MODELS_DIALOG.intro}</DialogDescription>
      </DialogHeader>
      <label className="grid gap-1 text-xs text-(--ui-text-secondary)">
        {LOCAL_MODELS_DIALOG.username}
        <Input
          autoComplete="off"
          disabled={busy}
          name="athena-hpc-username"
          onChange={event => setUsername(event.target.value)}
          value={username}
        />
      </label>
      <label className="grid gap-1 text-xs text-(--ui-text-secondary)">
        {LOCAL_MODELS_DIALOG.password}
        <Input
          // Not offered to a password manager or to form history: the password is not to be saved anywhere.
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          disabled={busy}
          name="athena-hpc-password"
          onChange={event => setPassword(event.target.value)}
          ref={passwordRef}
          type="password"
          value={password}
        />
      </label>
      <p className="text-xs text-(--ui-text-tertiary)">{LOCAL_MODELS_DIALOG.passwordKept}</p>
      {error ? (
        <p className="text-xs text-destructive" data-testid="athena-local-models-error" role="alert">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          disabled={busy}
          onClick={() => closeLocalModelsDialog({ cancelled: true })}
          type="button"
          variant="ghost"
        >
          {LOCAL_MODELS_DIALOG.cancel}
        </Button>
        <Button disabled={!ready} type="submit">
          {busy ? LOCAL_MODELS_DIALOG.connecting : LOCAL_MODELS_DIALOG.connect}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Mounted once per window (src/app/contrib/wiring.tsx). Renders nothing until a pick or a button opens it. */
export function AthenaLocalModelsDialog() {
  const { open } = useStore($localModelsDialog)

  return (
    <Dialog onOpenChange={next => !next && closeLocalModelsDialog({ cancelled: true })} open={open}>
      {open ? (
        <DialogContent
          className="max-w-md"
          data-testid="athena-local-models-dialog"
          // With a remembered user name the cursor starts in the password field (else in the first field).
          onOpenAutoFocus={event => {
            const field = $hpcBridge.get()?.username
              ? document.querySelector<HTMLInputElement>('input[name="athena-hpc-password"]')
              : null

            if (field) {
              event.preventDefault()
              field.focus()
            }
          }}
        >
          <SignInForm />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
