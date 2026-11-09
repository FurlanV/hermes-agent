// Athena: main-process policies built from the verified client config (F02 slice 16).
//
// Each new snapshot installs the deep-link seam (policy-seams.ts): an OS deep
// link that reaches a refused feature (`hermes://open/settings?tab=billing`,
// `hermes://open/cron`, a refused `hermes://<kind>/…`) is dropped by
// `handleDeepLink` with a log line. REST and IPC refusals (slice 17) stay
// allow-all here.

import { deepLinkEntries, type DeepLinkLike } from './app-locations'
import type { ClientConfigSnapshot } from './client-config-types'
import { featureEntryFilter } from './feature-registry'
import { setMainPolicySeams } from './policy-seams'

export function deepLinkPolicy(config: unknown): (link: DeepLinkLike) => boolean {
  const filter = featureEntryFilter(config)

  return link => deepLinkEntries(link).every(filter)
}

export function applyMainPolicies(snapshot: Pick<ClientConfigSnapshot, 'config'>): void {
  setMainPolicySeams({ deepLink: deepLinkPolicy(snapshot.config) })
}

