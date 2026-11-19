import type { PayloadRequest, ServerProps } from 'payload'

import { CLOUDFLARE_ANALYTICS_CUSTOM_KEY, DEFAULT_ENDPOINT_PATH } from '../constants'
import { parseAnalyticsRange } from '../query'
import type { CloudflareAnalyticsService } from '../service'
import type { AnalyticsLoadResult } from '../types'
import { AnalyticsPanel } from './AnalyticsPanel.client'

const endpointUrl = (apiPath: string, endpointPath: string): string =>
  `${apiPath.replace(/\/+$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`

/**
 * Admin dashboard widget. It loads the first render on the server, then hands the data to the
 * client panel, whose 7/30-day toggle reads the endpoint. With no site tag it renders the
 * "not set up" message instead of an error.
 */
export const CloudflareAnalyticsDashboard = async ({
  payload,
  searchParams,
  server,
  user,
}: ServerProps) => {
  const range = parseAnalyticsRange(searchParams?.range)
  const service = payload.config.custom?.[CLOUDFLARE_ANALYTICS_CUSTOM_KEY] as
    | CloudflareAnalyticsService
    | undefined

  let initialResult: AnalyticsLoadResult = { configured: false }
  let initialError: string | undefined
  if (service) {
    try {
      // beforeDashboard components do not receive the Payload request. Rebuild the parts a
      // tenant resolver needs (signed-in user and request headers, including cookies); the
      // endpoint always uses the real request.
      const request = {
        context: {},
        headers: await server.getHeaders(),
        payload,
        payloadAPI: 'rest',
        searchParams: new URLSearchParams(
          Object.entries(searchParams ?? {}).flatMap(([key, value]) =>
            Array.isArray(value)
              ? value.map((item) => [key, String(item)] as [string, string])
              : value === undefined
                ? []
                : [[key, String(value)] as [string, string]],
          ),
        ),
        user: user ?? null,
      } as unknown as PayloadRequest
      initialResult = await service.load({ range, req: request })
    } catch {
      initialError = 'Could not load Cloudflare analytics.'
    }
  }

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1.25rem', margin: '0 0 0.75rem' }}>Cloudflare Analytics</h2>
      <AnalyticsPanel
        endpoint={endpointUrl(
          payload.config.routes.api ?? '/api',
          service?.endpointPath ?? DEFAULT_ENDPOINT_PATH,
        )}
        initialError={initialError}
        initialRange={range}
        initialResult={initialResult}
      />
    </section>
  )
}
