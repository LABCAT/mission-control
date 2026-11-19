import type { APIRoute } from 'astro'

import { robotsTxt } from '../robots'

export const GET: APIRoute = ({ url }) =>
  new Response(robotsTxt(url.hostname), {
    headers: {
      'cache-control': 'public, max-age=3600',
      'content-type': 'text/plain; charset=utf-8',
    },
  })
