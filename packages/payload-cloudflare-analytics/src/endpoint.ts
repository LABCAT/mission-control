import type { Endpoint, PayloadRequest } from 'payload'

import { parseAnalyticsRange } from './query'
import type { CloudflareAnalyticsService } from './service'

const JSON_HEADERS = { 'Cache-Control': 'no-store' }

const unauthorized = () =>
  Response.json({ error: 'You must be signed in to view analytics.' }, { headers: JSON_HEADERS, status: 401 })

/**
 * Read-only analytics endpoint for the admin dashboard. It is registered as a Payload root
 * endpoint, so the URL is `/api/<endpointPath>`.
 */
export const createAnalyticsEndpoint = ({
  path,
  service,
}: {
  path: string
  service: CloudflareAnalyticsService
}): Endpoint => ({
  handler: async (req: PayloadRequest) => {
    if (!req.user) return unauthorized()

    const range = parseAnalyticsRange(req.searchParams?.get('range'))
    try {
      const result = await service.load({ range, req })
      return Response.json(result, { headers: JSON_HEADERS })
    } catch {
      // Fixed message: the token, upstream body and upstream error text stay out of the response.
      return Response.json(
        { error: 'Cloudflare analytics is unavailable right now.' },
        { headers: JSON_HEADERS, status: 502 },
      )
    }
  },
  method: 'get',
  path,
})
