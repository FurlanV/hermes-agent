/**
 * Athena managed-client boot (F02), imported for its side effect by
 * `src/main.tsx` before the app renders: follow Electron main's verified client
 * config, and install the feature filter (and the in-page row hiding) and the
 * role's model list it implies, so every surface reads one live copy.
 */

import { connectClientConfig } from './client-config'
import { installDesktopPins } from './desktop-pins'
import { installEntryPointPolicies } from './entry-point-guards'
import { installFeaturePolicy } from './feature-policy'
import { installHiddenRowsStyle } from './hidden-rows'
import { installModelPolicy } from './model-policy'
import { installToolInstallPolicy } from './tool-installs'

installFeaturePolicy()
connectClientConfig()
installEntryPointPolicies()
installDesktopPins()
installModelPolicy()
installToolInstallPolicy()

if (typeof document !== 'undefined') {
  installHiddenRowsStyle()
}
