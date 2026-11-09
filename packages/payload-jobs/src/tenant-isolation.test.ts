import type { CollectionConfig } from 'payload'

import { tenantIsolation } from './test'

// A minimal tenant-scoped collection that proves the Postgres test harness catches
// cross-tenant leakage before the real job-board collections (PJ-16 onwards) exist.
const Widgets: CollectionConfig = {
  slug: 'widgets',
  fields: [{ name: 'title', type: 'text', required: true }],
  versions: false,
}

tenantIsolation({
  collection: Widgets,
  createData: () => ({ title: 'A widget' }),
})
