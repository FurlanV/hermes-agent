import { managedByLine, useClientConfig } from './client-config'

/** Settings › About: one read-only line naming who manages this app, the role and the config in use. */
export function AthenaManagedLine() {
  const snapshot = useClientConfig()

  return (
    <p
      className="mx-auto mt-3 w-full max-w-2xl text-center text-xs text-(--ui-text-tertiary)"
      data-athena-managed-line=""
      title={snapshot?.error && snapshot.error !== 'missing' ? `Ignored config file: ${snapshot.error}` : undefined}
    >
      {managedByLine(snapshot)}
    </p>
  )
}
