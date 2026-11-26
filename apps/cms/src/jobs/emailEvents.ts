import { consumeDeliveryEvents, emailEngineConfig, type QueueMessage } from '@mission-control/payload-jobs'
import type { Payload } from 'payload'

/**
 * The Queue handler for Cloudflare Email Sending delivery events (PJ-107). If email, or its
 * suppression list, is not enabled on this Payload instance there is nothing to update, so every
 * message is acknowledged and dropped: the Worker never crashes over it.
 */
export const handleEmailEvents = async (messages: readonly QueueMessage[], load: () => Promise<Payload>) => {
  const payload = await load()

  let config: ReturnType<typeof emailEngineConfig>
  try {
    config = emailEngineConfig(payload)
  } catch {
    config = undefined as never
  }
  if (!config?.suppressionsSlug) {
    for (const message of messages) message.ack()

    return { applied: 0, dropped: messages.length, retried: 0 }
  }

  return consumeDeliveryEvents({ logSlug: config.logSlug, payload, suppressionsSlug: config.suppressionsSlug }, messages)
}
