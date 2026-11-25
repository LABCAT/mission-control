import type { APIRoute } from 'astro'

import { siteLlms } from '../llms'

/** `/llms.txt` (PJ-104): the site summary and its key URLs, for AI agents. */
export const GET: APIRoute = ({ site }) =>
  siteLlms({ siteUrl: site ? site.origin : null })
