import type { PluginConfig } from '@payloadcms/plugin-form-builder/types'

import {
  authenticatedAccess,
  formEmailSender,
  ensureFormNotification,
  superAdminAccess,
} from '@mission-control/payload-jobs'

/**
 * The form builder's collections on this CMS (PJ-102). They are tenant content, like pages:
 * a site manager edits their own site's forms and reads its submissions, but nobody reads
 * them with a site key and the public write path is the plugin's `forms/submit` endpoint,
 * which checks Turnstile and the honeypot itself.
 *
 * `submissionData` is personal data: it is never anonymous, and the purge task deletes it
 * after the tenant's `formRetentionDays`.
 */

export const FORMS_SLUG = 'forms'
export const FORMS_SUBMISSIONS_SLUG = 'form-submissions'

export const formBuilderOptions = (): PluginConfig => ({
  // The notification is sent as the tenant (never a hardcoded sender) through the CMS email
  // path, and a form with no Emails row still notifies the tenant's admin (PJ-102).
  beforeEmail: formEmailSender({ tenantsSlug: 'tenants' }),
  fields: {
    // Uploads would need an upload collection on every site's storage, and payment fields
    // belong to orders (PJ-23), not to a public contact form.
    payment: false,
    upload: false,
  },
  formOverrides: {
    slug: FORMS_SLUG,
    access: {
      create: authenticatedAccess,
      delete: superAdminAccess,
      read: authenticatedAccess,
      update: authenticatedAccess,
    },
    admin: { group: 'Content', useAsTitle: 'title' },
    hooks: {
      // A form saved without an Emails row would collect submissions silently.
      beforeChange: [({ data }) => ensureFormNotification(data)],
    },
    versions: false,
  },
  formSubmissionOverrides: {
    slug: FORMS_SUBMISSIONS_SLUG,
    // Closed to the outside: the plugin's endpoint creates a submission with `overrideAccess`,
    // so the Turnstile check and the retention rule cannot be skipped by posting to the
    // collection directly. Reading is for signed-in staff only.
    access: {
      create: () => false,
      delete: superAdminAccess,
      read: ({ req }) => Boolean(req.user),
      update: () => false,
    },
    admin: { group: 'Content', useAsTitle: 'id' },
    versions: false,
  },
})
