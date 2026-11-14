import type { CollectionConfig } from 'payload'

import { emailTemplatesCollection } from './email-templates'
import { tenantIsolation } from './test'

// A minimal tenant-scoped collection that proves the Postgres test harness catches
// cross-tenant leakage before the real job-board collections (PJ-16 onwards) exist.
const Widgets: CollectionConfig = {
  slug: 'widgets',
  fields: [{ name: 'title', type: 'text', required: true }],
  versions: false,
}

const emailTemplates = emailTemplatesCollection()

tenantIsolation({
  collection: Widgets,
  createData: () => ({ title: 'A widget' }),
  withCollections: [emailTemplates],
})

// The same key may exist in two tenants: uniqueness is per tenant, not global.
tenantIsolation({
  collection: emailTemplates,
  createData: () => ({
    body: '<p>Hi {{name}}</p>',
    enabled: true,
    key: 'new_user',
    subject: 'Welcome to {{siteName}}',
  }),
  withCollections: [Widgets],
})
