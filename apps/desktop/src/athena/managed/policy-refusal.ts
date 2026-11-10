/**
 * The typed "refused by policy" error every Athena seam raises (F02).
 *
 * - JSON-RPC (`rpc-seam.ts`) throws a `PolicyRefusedError` directly.
 * - REST is refused in Electron main (`electron/athena/policy-seams.ts`);
 *   custom Error properties do not survive contextBridge, so the rejection
 *   carries the same message and `PolicyRefusedError.from` turns it back into
 *   this type.
 *
 * Keep `policyRefusalMessage` in step with the main-process copy; the seam
 * tests check both.
 */

export type PolicyRefusalKind = 'deep-link' | 'ipc' | 'rest' | 'rpc'

export const POLICY_REFUSED_CODE = 'refused_by_policy'

const KINDS: readonly PolicyRefusalKind[] = ['deep-link', 'ipc', 'rest', 'rpc']

export const policyRefusalMessage = (kind: PolicyRefusalKind, target: string): string =>
  `${POLICY_REFUSED_CODE}: ${kind} ${target}`

const MESSAGE_RE = new RegExp(`${POLICY_REFUSED_CODE}: (${KINDS.join('|')}) (.+)$`)

export class PolicyRefusedError extends Error {
  readonly code = POLICY_REFUSED_CODE

  constructor(
    readonly kind: PolicyRefusalKind,
    /** What was refused: the JSON-RPC method, or `<METHOD> <pathname>` for REST. */
    readonly target: string
  ) {
    super(policyRefusalMessage(kind, target))
    this.name = 'PolicyRefusedError'
  }

  /** The refusal behind `error` (itself, or a bridged rejection carrying its message), else null. */
  static from(error: unknown): null | PolicyRefusedError {
    if (error instanceof PolicyRefusedError) {
      return error
    }

    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    const match = MESSAGE_RE.exec(message)

    return match ? new PolicyRefusedError(match[1] as PolicyRefusalKind, match[2]) : null
  }
}

export const isPolicyRefusal = (error: unknown): boolean => PolicyRefusedError.from(error) !== null
