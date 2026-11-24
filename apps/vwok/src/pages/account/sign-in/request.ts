import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

import { handleSignInRequest } from '../../../sign-in-handlers'

// Sign-in (PJ-109): POST only. Astro answers 405 to anything else.
export const prerender = false

export const POST: APIRoute = ({ request }) => handleSignInRequest(request, env)
