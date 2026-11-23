import { tenantFromSettings, type CmsClient } from '@mission-control/launchpad/cms'
import { loadJobDetail, type JobDetailView } from '@mission-control/launchpad/jobs/detail'
import { lexicalToHtml } from '@mission-control/rocketship-payload/richtext'

import { siteTenant } from './brand'

/**
 * What `/jobs/{slug}` answers (PJ-37). `gone` is the site's 410 and `not-found` its 404; a live
 * or expired job both render the page (an expired one with the notice, `noindex`, no JobPosting).
 */
export type JobRoute =
  | { kind: 'gone' }
  | { kind: 'job'; view: JobDetailView }
  | { kind: 'not-found' }

/**
 * Resolve one job path. The tenant's rules (expired mode, the 410 window, public views) come from
 * the CMS's site settings, never from this app; if the settings cannot be read the documented
 * defaults apply, so a CMS blip cannot turn a live job into a 404.
 */
export const jobRoute = async ({
  cms,
  now,
  siteUrl,
  slug,
}: {
  cms: Pick<CmsClient, 'find' | 'findBySlug' | 'siteSettings'> | null
  now?: Date
  siteUrl?: string
  slug: string
}): Promise<JobRoute> => {
  if (!cms || !slug) return { kind: 'not-found' }

  const settings = await cms.siteSettings().catch(() => null)
  const result = await loadJobDetail({
    cms,
    descriptionHtml: lexicalToHtml,
    now,
    siteUrl,
    slug,
    tenant: tenantFromSettings(settings, siteTenant),
  })

  if (!result.found) return { kind: 'not-found' }
  if (result.status === 'gone') return { kind: 'gone' }

  return { kind: 'job', view: result.view }
}
