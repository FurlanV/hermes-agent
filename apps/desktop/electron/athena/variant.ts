// Athena: which build variant is running (F02 slice 18).
//
// The managed client (feature filter, backend refusals, pins, removed
// features) is the Athena variant's. A stock build (`HERMES_DESKTOP_VARIANT`
// unset, or another variant) carries the same code but leaves it inert: main
// installs allow-all seams and the renderer an allow-all filter, so it behaves
// like upstream hermes desktop. The Athena variant is recognised by its install
// stamp (`brand: "athena"`, scripts/write-build-stamp.mjs) or, for an unstamped
// dev bundle, by the baked identity's app id (product-identity.cjs, from
// src/athena/branding.json: `appIdPrefix` + `kebab`).

export type DesktopVariant = 'athena' | 'stock'

/** `${branding.appIdPrefix}.${branding.kebab}`; variant.test.ts checks it against branding.json. */
export const ATHENA_APP_ID = 'ca.sickkids.athena'

export function desktopVariant(installStamp: unknown, appId: string | undefined): DesktopVariant {
  if (installStamp && typeof installStamp === 'object' && (installStamp as { brand?: unknown }).brand === 'athena') {
    return 'athena'
  }

  return appId === ATHENA_APP_ID ? 'athena' : 'stock'
}
