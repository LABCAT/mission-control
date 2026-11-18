import { emailTemplatesCollection } from './email-templates'
import { tenantIsolation } from './test'

// The same key may exist in two tenants: uniqueness is per tenant, not global. Each boot
// gets its own schema, so the suite is safe to run in the same database as the others.
tenantIsolation({
  collection: emailTemplatesCollection(),
  createData: () => ({
    body: '<p>Hi {{name}}</p>',
    enabled: true,
    key: 'new_user',
    subject: 'Welcome to {{siteName}}',
  }),
})
