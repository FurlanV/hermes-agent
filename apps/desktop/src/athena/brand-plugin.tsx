import { CHAT_EMPTY_AREA, type ChatEmptyProps, type HermesPlugin } from '@hermes/plugin-sdk'

import branding from './branding.json'
import { AthenaSplash } from './splash'

/**
 * Bundled through src/plugins/athena-brand/plugin.tsx (the bundled-plugin
 * glob). The splash registers first in `chat.empty` (lowest order), so other
 * cards in that area, like the Athena sign-in card, sit below it. The Athena
 * skin is the default through DEFAULT_SKIN_NAME, so no theme request is needed.
 */
const athenaBrand: HermesPlugin = {
  id: 'athena-brand',
  name: `${branding.display} branding`,
  description: `The ${branding.display} splash on an empty chat.`,
  register(ctx) {
    ctx.register({
      id: 'splash',
      area: CHAT_EMPTY_AREA,
      order: -1000,
      data: {
        render: (_props: ChatEmptyProps) => <AthenaSplash />
      }
    })
  }
}

export default athenaBrand
