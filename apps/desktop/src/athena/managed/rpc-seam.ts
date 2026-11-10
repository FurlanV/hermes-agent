/**
 * The renderer's JSON-RPC seam (F02). Every gateway JSON-RPC request the
 * Desktop sends, desktop plugins' `host.request` included, passes
 * `assertRpcAllowed` at the top of `HermesGateway.request`
 * (`src/api/client.ts`).
 *
 * It lives in the renderer because that is where the traffic is: the renderer
 * dials the gateway daemon's `/api/ws` itself and Electron main only mints the
 * one-use ticket (check M4). Allows everything today; a later slice installs
 * a policy built from the feature registry with `setRpcPolicy`.
 */

import { atom } from 'nanostores'

import { PolicyRefusedError } from './policy-refusal'

/** True when the request may be sent. Gets the caller's method and params (before protocol rewriting). */
export type RpcPolicy = (method: string, params: Readonly<Record<string, unknown>>) => boolean

export const ALLOW_ALL_RPC: RpcPolicy = () => true

export const $rpcPolicy = atom<RpcPolicy>(ALLOW_ALL_RPC)

/** Install a policy (`null` restores allow-everything). */
export function setRpcPolicy(policy: null | RpcPolicy): void {
  $rpcPolicy.set(policy ?? ALLOW_ALL_RPC)
}

/** Throws a `PolicyRefusedError` (kind `rpc`) when the policy refuses the request. */
export function assertRpcAllowed(method: string, params: Readonly<Record<string, unknown>> = {}): void {
  if (!$rpcPolicy.get()(method, params)) {
    throw new PolicyRefusedError('rpc', method)
  }
}
