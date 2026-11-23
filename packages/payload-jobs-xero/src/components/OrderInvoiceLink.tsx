import type { ServerProps } from 'payload'

import { getPayloadJobsRegistry, type MissionControlUser } from '@mission-control/payload-jobs'

import { InvoiceLinkError, readOrderInvoiceConfig, resolveOrderInvoiceLink } from '../invoice-link'

/**
 * The order's invoice on its edit view in the admin (PJ-58): a server component, no client JS.
 * It resolves the invoice with the signed-in admin's own access, so it shows nothing they could
 * not open, and renders a plain anchor: Xero's page in a new tab, or the HTML fallback served by
 * `GET /api/orders/:id/invoice`. An order with no invoice renders nothing.
 */
export const OrderInvoiceLink = async ({ id, payload, user }: ServerProps) => {
  if (id === undefined) return null

  const config = readOrderInvoiceConfig(payload.config)
  if (!config) return null

  let link
  try {
    link = await resolveOrderInvoiceLink({
      config,
      orderID: id,
      payload,
      registry: getPayloadJobsRegistry(payload.config as never),
      user: (user as MissionControlUser | null) ?? null,
    })
  } catch (error) {
    // A refusal is an ordinary answer: an order with no invoice, or a user who may not open this
    // one, sees nothing. Only a fault is worth a log line.
    if (!(error instanceof InvoiceLinkError)) {
      payload.logger.error({ err: error, msg: `invoice link: order ${String(id)}` })
    }
    return null
  }

  if (link.kind === 'xero') {
    return (
      <a href={link.url} rel="noopener noreferrer" target="_blank">
        Open invoice in Xero
      </a>
    )
  }

  const href = `${payload.config.routes.api}/orders/${encodeURIComponent(String(id))}/invoice`
  return <a href={href}>Open invoice</a>
}
