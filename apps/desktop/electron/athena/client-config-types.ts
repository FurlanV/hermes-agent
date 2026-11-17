// Athena client config types shared by main and the renderer (no runtime imports, so the renderer can use them).

import type { JwsReason } from './jws'
import type { DesktopVariant } from './variant'

export type ClientConfigDocument = Record<string, unknown>
export type ClientConfigSource = 'bundled' | 'last-good' | 'server'

/** Why the current file was not used (null when it verified). JWS reasons plus these. */
export type ClientConfigRejection =
  | 'bad_payload'
  | 'expired'
  | 'missing'
  | 'no_subject'
  | 'replayed_version'
  | 'schema_too_new'
  | 'wrong_audience'
  | 'wrong_subject'
  | 'wrong_type'
  | JwsReason

/** Where this laptop's HPC bridge listens (F05): what main read from a live bridge record (hpc-bridge-record.ts). */
export interface HpcBridgeAddress {
  /** A loopback address. */
  address: string
  /** When the forward came up (ISO 8601), if the record says. */
  connectedAt: null | string
  /** The default model server's forward; absent while that server is down and another is up. */
  port?: number
  /**
   * The port of every model server whose forward is up, by server id (`default` included), when the record lists
   * them (version 2, F05 slice 12). Absent for a version 1 record: the default server alone, on `port`.
   */
  servers?: Record<string, number>
}

/**
 * What the Profile's hermes managed scope declares about the Model gateway's models (F13 slice 18): what main read
 * from `$HERMES_MANAGED_DIR/config.yaml`, the file athena's applier writes after each sync (managed-scope.ts).
 */
export interface ManagedScopeModels {
  /** Its `model.default` (null when it names none): the model hermes starts a session on. */
  default: null | string
  /**
   * The model ids declared on each Model gateway provider, by its `providers` key (`athena-gateway`,
   * `athena-gateway-chat`): the keys of its `models` dict, or the items of an older applier's list. A provider the
   * file has no entry for is absent: it declares nothing.
   */
  declared: Record<string, string[]>
}

/** What main hands the renderer. `config` is the effective document (bundled < chosen < dev override). */
export interface ClientConfigSnapshot {
  config: ClientConfigDocument
  configVersion: null | number
  devOverridesActive: boolean
  /** The reason the file on disk was not used, if it was not (`missing` when there is none). */
  error: ClientConfigRejection | null
  /**
   * The HPC bridge of this Profile while it is up (F05 slice 05): present only with a live bridge record. Not
   * part of the signed config; it rides the snapshot so pickers and the model gate change with the bridge.
   */
  hpcBridge?: HpcBridgeAddress
  /**
   * The Model gateway models hermes managed scope declares (F13 slice 18): absent while the managed file is missing
   * or cannot be read. Not part of the signed config; under `managed.models: enforce` a gateway model is listed only
   * once it is declared here, because hermes refuses a pick of one that is not (docs/hermes-findings.md 9.1).
   */
  managedScope?: ManagedScopeModels
  role: null | string
  source: ClientConfigSource
  /**
   * The build variant (slice 18). `stock` leaves the managed client inert (allow-all filter and seams); absent
   * (older snapshots, tests) reads as `athena`.
   */
  variant?: DesktopVariant
  /** When the config in use was last verified (null for the bundled default). */
  verifiedAt: null | string
}
