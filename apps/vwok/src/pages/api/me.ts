import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

import { handleMe } from '../../view-as-handlers'

// Always dynamic and never cached: it answers for whoever holds the cookie.
export const prerender = false

export const GET: APIRoute = ({ request }) => handleMe(request, env)
