/**
 * Delivery events as the Queue consumer receives them. These are written to the documented shape
 * (type `message.<kind>`, `payload.messageId`) because Cloudflare's docs could not be reached when
 * PJ-107 was built; replace them with recorded events once a real subscription has produced some.
 */
export const eventFor = (kind: string, messageId: string, extra: Record<string, unknown> = {}) => ({
  type: `message.${kind}`,
  timestamp: '2026-11-26T01:00:00.000Z',
  payload: { messageId, ...extra },
})
