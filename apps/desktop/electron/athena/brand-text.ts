// Athena (F14 slice 06): the main process's brand pass. In the Athena build, text main shows a user (tray, native
// dialogs and notifications, boot progress, update and setup messages, pages it serves) names the product
// instead of Hermes, under the naming rules in hermes-names.ts. In a stock build `brandText` returns its input.
//
// This module imports nothing else from main, so pure modules can wrap a line without pulling in the install
// stamp or the identity. brand-text-install.ts switches it on at startup (first import of main.ts).

import { renameHermes } from './hermes-names'

let product: null | string = null

/** Turn the pass on with the product name (the identity's display name), or off with `null`. */
export function setMainBrand(name: null | string): void {
  product = name
}

/** True once the Athena build's startup has switched the pass on. */
export function mainBrandActive(): boolean {
  return product !== null
}

/** `text` as the running build names the app. */
export function brandText(text: string): string {
  return product === null ? text : renameHermes(text, product)
}
