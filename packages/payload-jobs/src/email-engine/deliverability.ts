import type { CollectionSlug, Payload, PayloadRequest } from 'payload'

import type { EmailLogStatus } from './log'
import { suppressAddress, type SuppressionReason } from './suppressions'

/**
 * Delivery events for mail sent through Cloudflare Email Sending (PJ-107): a Cloudflare Queue
 * delivers each event to the CMS Worker, and `applyDeliveryEvent` moves the email-log row for
 * that message forward. A hard bounce or a complaint also suppresses the address for the tenant.
 * Soft bounces and deferrals are recorded only.
 *
 * The parser is deliberately tolerant about shape, because the event schema could not be checked
 * against Cloudflare's docs when this was written (see the PR). It accepts the type as
 * `message.bounced` or `bounced`, the payload at the top level or under `payload`/`data`, and the
 * message id with or without angle brackets.
 */

export const DELIVERY_EVENT_KINDS = ['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'] as const
export type DeliveryEventKind = (typeof DELIVERY_EVENT_KINDS)[number]

export type DeliveryEvent = {
  /** Only meaningful for `bounced`. Unknown bounce types count as hard. */
  bounceType?: 'hard' | 'soft'
  kind: DeliveryEventKind
  messageId: string
  occurredAt?: string
}

/** `<abc@mail.example>` and `abc@mail.example` are the same message. */
export const normaliseMessageId = (id: string): string => id.trim().replace(/^<|>$/g, '').trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

const SOFT = /soft|transient|temporary/i

export const parseDeliveryEvent = (raw: unknown): DeliveryEvent | null => {
  if (!isRecord(raw)) return null

  const nested = isRecord(raw.payload) ? raw.payload : isRecord(raw.data) ? raw.data : {}
  const pick = (key: string): unknown => nested[key] ?? raw[key]

  const type = text(raw.type) ?? text(raw.event) ?? text(raw.eventType)
  const kind = type?.split('.').pop()?.toLowerCase() as DeliveryEventKind | undefined
  if (!kind || !DELIVERY_EVENT_KINDS.includes(kind)) return null

  const id = text(pick('messageId')) ?? text(pick('message_id'))
  if (!id) return null

  const nestedBounce = pick('bounce')
  const bounce =
    (isRecord(nestedBounce) ? text(nestedBounce.type) : undefined) ?? text(pick('bounceType')) ?? text(pick('bounce_type'))
  const occurredAt = text(raw.timestamp) ?? text(raw.occurredAt) ?? text(pick('timestamp'))

  return {
    ...(kind === 'bounced' ? { bounceType: bounce && SOFT.test(bounce) ? ('soft' as const) : ('hard' as const) } : {}),
    kind,
    messageId: normaliseMessageId(id),
    ...(occurredAt ? { occurredAt } : {}),
  }
}

/** Events can arrive out of order: a row only ever moves to an equal or later state. */
const STATUS_RANK: Record<EmailLogStatus, number> = {
  skipped: 0,
  sent: 1,
  deferred: 2,
  delivered: 3,
  failed: 4,
  rejected: 4,
  bounced: 5,
  complained: 6,
}

const STATUS_OF: Record<DeliveryEventKind, EmailLogStatus> = {
  bounced: 'bounced',
  complained: 'complained',
  deferred: 'deferred',
  delivered: 'delivered',
  failed: 'failed',
  rejected: 'rejected',
}

export type DeliverabilityContext = {
  clock?: () => Date
  logSlug: string
  payload: Payload
  suppressionsSlug: string
}

export type DeliveryResult = {
  outcome: 'applied' | 'ignored' | 'unknown-message'
  suppressed?: boolean
}

type LogRow = {
  bounceType?: null | string
  id: number | string
  recipient?: null | string
  recipientMasked?: boolean | null
  redirected?: boolean | null
  status: EmailLogStatus
  tenant?: unknown
}

const tenantOf = (value: unknown): null | number | string => {
  if (value === null || value === undefined) return null

  return typeof value === 'object' ? ((value as { id: number | string }).id ?? null) : (value as number | string)
}

export const applyDeliveryEvent = async (ctx: DeliverabilityContext, event: DeliveryEvent): Promise<DeliveryResult> => {
  const { docs } = await ctx.payload.find({
    collection: ctx.logSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { messageId: { equals: event.messageId } },
  })
  const row = docs[0] as unknown as LogRow | undefined
  if (!row) return { outcome: 'unknown-message' }

  const status = STATUS_OF[event.kind]
  if (STATUS_RANK[status] < STATUS_RANK[row.status]) return { outcome: 'ignored' }

  const now = (ctx.clock ?? (() => new Date()))()
  await ctx.payload.update({
    collection: ctx.logSlug as CollectionSlug,
    data: {
      ...(event.bounceType ? { bounceType: event.bounceType } : {}),
      status,
      statusAt: event.occurredAt && !Number.isNaN(Date.parse(event.occurredAt)) ? event.occurredAt : now.toISOString(),
    } as never,
    id: row.id,
    overrideAccess: true,
  })

  const reason: SuppressionReason | null =
    event.kind === 'complained' ? 'complaint' : event.kind === 'bounced' && event.bounceType === 'hard' ? 'bounce' : null
  // A redirected row went to the test inbox, and a masked one no longer names the address.
  if (!reason || row.redirected || row.recipientMasked || !row.recipient) return { outcome: 'applied', suppressed: false }

  // The tenant comes from our own log row, never from the event.
  const suppressed = await suppressAddress({
    address: row.recipient,
    now,
    payload: ctx.payload,
    reason,
    slug: ctx.suppressionsSlug,
    tenantID: tenantOf(row.tenant),
  })

  return { outcome: 'applied', suppressed }
}

export type QueueMessage = {
  ack(): void
  attempts?: number
  body: unknown
  retry(options?: { delaySeconds?: number }): void
}

/** A message whose log row does not exist yet (event beat the log write) is retried a few times. */
export const MAX_UNKNOWN_ATTEMPTS = 5

/**
 * The Queue consumer: one call per batch. Unparseable events are acked (retrying never fixes
 * them); an event for a message we have no row for is retried with a delay, then dropped; an
 * error is retried.
 */
export const consumeDeliveryEvents = async (
  ctx: DeliverabilityContext,
  messages: readonly QueueMessage[],
): Promise<{ applied: number; dropped: number; retried: number }> => {
  const totals = { applied: 0, dropped: 0, retried: 0 }

  for (const message of messages) {
    const event = parseDeliveryEvent(message.body)
    if (!event) {
      totals.dropped += 1
      message.ack()
      continue
    }

    try {
      const result = await applyDeliveryEvent(ctx, event)
      if (result.outcome === 'unknown-message' && (message.attempts ?? 1) < MAX_UNKNOWN_ATTEMPTS) {
        totals.retried += 1
        message.retry({ delaySeconds: 30 })
        continue
      }
      if (result.outcome === 'applied') totals.applied += 1
      else totals.dropped += 1
      message.ack()
    } catch {
      totals.retried += 1
      message.retry({ delaySeconds: 60 })
    }
  }

  return totals
}

export type DeliverabilityStats = { bounced: number; complaints: number; delivered: number; sent: number }

/** The admin numbers: the tenant's mail over the last `days` days. `sent` is everything a transport accepted. */
export const deliverabilityStats = async ({
  days = 30,
  logSlug,
  now = new Date(),
  payload,
  req,
  tenantID,
}: {
  days?: number
  logSlug: string
  now?: Date
  payload: Payload
  /** With a request, counts obey that user's read access (so the tenant filter applies). */
  req?: PayloadRequest
  tenantID: null | number | string
}): Promise<DeliverabilityStats> => {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const base = [...(tenantID === null ? [] : [{ tenant: { equals: tenantID } }]), { sentAt: { greater_than_equal: since } }]
  const count = async (...extra: Record<string, unknown>[]) =>
    (
      await payload.count({
        collection: logSlug as CollectionSlug,
        overrideAccess: !req,
        ...(req ? { req } : {}),
        where: { and: [...base, ...extra] } as never,
      })
    ).totalDocs

  const [accepted, failedAfterSend, delivered, bounced, complaints] = await Promise.all([
    count({ status: { not_in: ['skipped', 'failed'] } }),
    count({ status: { equals: 'failed' } }, { messageId: { exists: true } }),
    count({ status: { equals: 'delivered' } }),
    count({ status: { equals: 'bounced' } }),
    count({ status: { equals: 'complained' } }),
  ])

  return { bounced, complaints, delivered, sent: accepted + failedAfterSend }
}
