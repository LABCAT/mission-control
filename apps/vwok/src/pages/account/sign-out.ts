import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

import { handleSignOut } from '../../sign-in-handlers'

// Sign out (PJ-109): POST only, so a link or image on another site cannot sign anyone out.
export const prerender = false

export const POST: APIRoute = ({ request }) => handleSignOut(request, env)
