// Athena (F14 slice 06): switch the main process's brand pass on in the Athena build, with the display name the
// product identity already carries. Imported by ipc-guard-install.ts, the first import of main.ts, so it runs
// before main builds a menu, a tray or a window. A stock build leaves the pass off.

import { INSTALL_STAMP } from '../install-stamp'
import { PRODUCT_IDENTITY } from '../product-identity'

import { setMainBrand } from './brand-text'
import { desktopVariant } from './variant'

setMainBrand(desktopVariant(INSTALL_STAMP, PRODUCT_IDENTITY.appId) === 'athena' ? PRODUCT_IDENTITY.displayName : null)
