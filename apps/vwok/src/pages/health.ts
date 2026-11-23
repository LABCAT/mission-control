import type { APIRoute } from 'astro'

import { siteEnv } from '../env'
import { siteHealth } from '../health'

// Always dynamic and never cached: a cached 200 would hide an outage.
export const prerender = false

export const GET: APIRoute = async () => siteHealth(await siteEnv())
