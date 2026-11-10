/**
 * The admin's labels for the role's models (F02 slice 20): `models.allowed[].label`
 * from the client config, installed by `model-policy.ts`. `modelDisplayParts`
 * (`src/lib/model-status-label.ts`) asks here first, so every surface that names
 * a model (picker rows, the composer pill, session rows, Settings) shows
 * "GPT-6 Sol" instead of a prettified id. Import-free: the display helpers load it.
 */

let labels: null | ReadonlyMap<string, string> = null

/** Install the labels (`null` restores the stock names). */
export function setManagedModelLabels(next: null | ReadonlyMap<string, string>): void {
  labels = next && next.size > 0 ? next : null
}

/** The admin's label for a model id, or undefined (stock name). */
export function managedModelLabel(model: string): string | undefined {
  return labels?.get(model.trim())
}
