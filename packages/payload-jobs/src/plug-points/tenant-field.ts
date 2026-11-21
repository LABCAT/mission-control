import type { Field } from 'payload'

import { ADD_ONS_FIELD, validateAddOnKeys } from './add-ons'
import type { PayloadJobsRegistry } from './payload-jobs-registry'

/**
 * The tenant's add-on switch (PJ-115): a JSON list of add-on keys, or empty for all of them.
 * JSON (not a multi-select) so "never chosen" stays different from "none": a tenant that
 * predates the setting keeps every add-on. Keys are checked against the registry when saved,
 * which add-on plugins fill in before any request.
 */
export const jobBoardAddOnsField = (registry: PayloadJobsRegistry): Field => ({
  name: ADD_ONS_FIELD,
  type: 'json',
  admin: {
    condition: (data: Record<string, unknown>) => data?.isAggregate !== true,
    description:
      'Which add-ons this site uses, for example ["alerts", "reports"]. Leave empty for all installed add-ons; [] switches them all off.',
  },
  validate: validateAddOnKeys((key) => registry.addOns.has(key)),
})
