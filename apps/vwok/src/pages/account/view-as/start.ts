import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

import { handleViewAsStart } from '../../../view-as-handlers'

// View as user (PJ-119): POST only. Astro answers 405 to anything else.
export const prerender = false

export const POST: APIRoute = ({ request }) => handleViewAsStart(request, env)
