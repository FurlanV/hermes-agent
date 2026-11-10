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

/** What main hands the renderer. `config` is the effective document (bundled < chosen < dev override). */
export interface ClientConfigSnapshot {
  config: ClientConfigDocument
  configVersion: null | number
  devOverridesActive: boolean
  /** The reason the file on disk was not used, if it was not (`missing` when there is none). */
  error: ClientConfigRejection | null
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
