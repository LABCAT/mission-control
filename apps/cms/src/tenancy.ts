import type { MultiTenantPluginConfig } from '@payloadcms/plugin-multi-tenant/types'

import type { PayloadJobsCollectionSlugs } from '@mission-control/payload-jobs'
import {
  denySeekerOnly,
  isSuperAdmin,
  resolvePayloadJobsSlugs,
  tenantRoleOptions,
} from '@mission-control/payload-jobs'

import { xeroTenantCollections } from '@mission-control/payload-jobs-xero'

import { FORMS_SLUG, FORMS_SUBMISSIONS_SLUG } from './forms'
import { siteKeyAccessOverrideFor } from './site-keys'

type AccessResultOverride = NonNullable<
  MultiTenantPluginConfig['collections'][keyof MultiTenantPluginConfig['collections']]
>['accessResultOverride']

/**
 * Every content collection that belongs to a tenant goes here. The plugin adds the
 * `tenant` field, tenant-scoped access and the tenant selector.
 *
 * `accessResultOverride` lets an anonymous request with a valid site key read its tenant.
 *
 * The plugin's collections are keyed by their resolved slugs, so a host that renames one keeps
 * its tenant scoping and site-key read access. Resolve the slugs once and pass the same object
 * to this function and to `payloadJobs`.
 */
export const multiTenantOptionsFor = (
  slugs: PayloadJobsCollectionSlugs = resolvePayloadJobsSlugs(),
  // mission-control: the alerts add-on's own slug (PJ-115), from `payloadJobsAlerts({ slug })`.
  alertSubscriptionsSlug = 'alert-subscriptions',
  // mission-control: the Xero add-on's settings and invoice records (PJ-57).
  xeroSlugs: string[] = xeroTenantCollections(),
): MultiTenantPluginConfig => {
  // mission-control: the plugin gives every tenant member access to the tenant's documents, so
  // seekers (site accounts, PJ-81) are denied here. Staff roles are unchanged.
  const tenantContentOverride = denySeekerOnly(siteKeyAccessOverrideFor(slugs))
  // mission-control: private to tenant members, never readable with a site key.
  const privateToTenant: AccessResultOverride = denySeekerOnly(({ accessResult }) => accessResult)

  return {
    collections: {
      // mission-control: documents are private to tenant members and not exposed to site keys;
      // seekers (site accounts, PJ-81) are denied.
      documents: { accessResultOverride: privateToTenant },
      folders: { accessResultOverride: tenantContentOverride },
      media: { accessResultOverride: tenantContentOverride },
      tags: { accessResultOverride: tenantContentOverride },
      // mission-control: job-board taxonomies (PJ-16). Job tags and areas of focus were
      // removed in PJ-80 (no legacy terms).
      [slugs.locations]: { accessResultOverride: tenantContentOverride },
      [slugs.jobCategories]: { accessResultOverride: tenantContentOverride },
      [slugs.jobTypes]: { accessResultOverride: tenantContentOverride },
      [slugs.salaryBands]: { accessResultOverride: tenantContentOverride },
      // mission-control: coupons are private to tenant members and not readable with a site
      // key; seekers are denied (PJ-22).
      [slugs.coupons]: { accessResultOverride: privateToTenant },
      // mission-control: organisations read site keys themselves (approved, page-enabled ones
      // only), so they skip the generic site key override; seekers are denied (PJ-18).
      [slugs.organisations]: { accessResultOverride: privateToTenant },
      // mission-control: plans read site keys themselves (active plans only), so they skip the
      // generic site key override; seekers are denied (PJ-21).
      [slugs.plans]: { accessResultOverride: privateToTenant },
      // mission-control: add-ons, like plans, read site keys themselves (on-sale only) (PJ-87).
      [slugs.addOns]: { accessResultOverride: privateToTenant },
      // mission-control: alert subscribers are personal data (PJ-26). The collection's own access
      // already denies site keys, seekers and anonymous callers, so no override is needed here.
      [alertSubscriptionsSlug]: {},
      // mission-control: applications and their CV files are personal data (PJ-25). Their own
      // access allows only super admins, site managers, the job's organisation and the applicant,
      // and denies site keys and anonymous callers, so no override is needed here.
      applications: {},
      'application-files': {},
      // mission-control: jobs read site keys themselves (published and expired only) (PJ-19).
      [slugs.jobs]: { accessResultOverride: privateToTenant },
      // mission-control: orders are private to the organisation and site managers, never readable
      // with a site key; seekers are denied (PJ-23).
      [slugs.orders]: { accessResultOverride: privateToTenant },
      // mission-control: the credit ledger is private to the organisation and site managers, never
      // readable with a site key; seekers are denied (PJ-24).
      [slugs.creditLedger]: { accessResultOverride: privateToTenant },
      // mission-control: email templates and the email log (PJ-50) are staff-only, never readable
      // with a site key; seekers are denied.
      [slugs.emailTemplates]: { accessResultOverride: privateToTenant },
      [slugs.emailLog]: { accessResultOverride: privateToTenant },
      // mission-control: Xero settings and invoice records are billing data: tenant admins and
      // super admins only (their own access), never a site key; seekers are denied (PJ-57).
      ...Object.fromEntries(xeroSlugs.map((slug) => [slug, { accessResultOverride: privateToTenant }])),
      // mission-control: content pages and menus (PJ-103). The generic override adds the site
      // key's tenant and, for the draft-enabled pages, published only.
      [slugs.menus]: { accessResultOverride: tenantContentOverride },
      [slugs.pages]: { accessResultOverride: tenantContentOverride },
      // mission-control: form definitions are content a site key may read, so the Form block
      // can render a form it points at (PJ-102). Submissions are personal data and are never
      // readable with a site key. The form-builder collections are not in the generated types
      // until a migration lands, hence the cast.
      ...({
        [FORMS_SLUG]: { accessResultOverride: tenantContentOverride },
        [FORMS_SUBMISSIONS_SLUG]: { accessResultOverride: privateToTenant },
      } as MultiTenantPluginConfig['collections']),
      // mission-control: site settings (PJ-67) are one document per site, so `isGlobal` makes the
      // tenant field unique and hides "create new". A site key reads the key's own site only.
      [slugs.siteSettings]: { accessResultOverride: tenantContentOverride, isGlobal: true },
    },
    tenantsArrayField: {
      rowFields: [
        {
          name: 'role',
          type: 'select',
          required: true,
          options: tenantRoleOptions,
          saveToJWT: true,
        },
      ],
    },
    tenantsSlug: 'tenants',
    userHasAccessToAllTenants: (user) => isSuperAdmin(user),
  }
}

export const multiTenantOptions = multiTenantOptionsFor()
