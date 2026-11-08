/**
 * docs.ts — canonical docs-site links used by the renderer's recovery and
 * setup surfaces. Single authority so the "reinstall the app" affordance
 * (bundled installs with a damaged payload) and any future doc links point
 * at the same place.
 */
import { athenaStrings } from '@/athena/strings'

export const DESKTOP_DOCS_URL = athenaStrings.supportUrl
