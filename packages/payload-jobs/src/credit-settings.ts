import type { CollectionSlug, Field, GlobalSlug, Payload, PayloadRequest } from 'payload'

import { tenantIDOf } from './catalog'

/**
 * When a pack plan's credits become usable (PJ-120): a per-tenant setting, on the tenant (or on
 * the single-tenant settings global) next to the other job-board settings.
 *
 * - `on_payment` (the default, and the old site's rule): a pack order's credits are added to the
 *   ledger only once the order is paid. Until then the job the pack was bought with follows its
 *   own payment rule, and an order cancelled or failed before payment grants nothing.
 * - `on_invoice`: the credits are added as soon as the order is invoiced.
 *
 * `packCreditsGrantingStatuses` says which order statuses may grant in each mode, and
 * `packCreditGrantProblem` is the one check the ledger (`grantCredits`) and checkout share, so
 * the two paths can't disagree.
 */

export const PACK_CREDIT_MODES = ['on_payment', 'on_invoice'] as const
export type PackCreditMode = (typeof PACK_CREDIT_MODES)[number]

export const DEFAULT_PACK_CREDIT_MODE: PackCreditMode = 'on_payment'

export const PACK_CREDIT_MODE_LABELS: Record<PackCreditMode, string> = {
  on_invoice: 'When the order is invoiced',
  on_payment: 'When the order is paid (the old site’s rule)',
}

export const isPackCreditMode = (value: unknown): value is PackCreditMode =>
  typeof value === 'string' && (PACK_CREDIT_MODES as readonly string[]).includes(value)

/** A tenant (or settings global) document, as far as pack credits are concerned. */
export type TenantPackCreditSource = { packCreditsUsableAt?: null | string }

/** The mode `tenant` uses. A tenant that never set it, or stored something else, keeps legacy. */
export const tenantPackCreditMode = (
  tenant: null | TenantPackCreditSource | undefined,
): PackCreditMode =>
  isPackCreditMode(tenant?.packCreditsUsableAt) ? tenant.packCreditsUsableAt : DEFAULT_PACK_CREDIT_MODE

/** The `packCreditsUsableAt` field for the tenants collection and the settings global. */
export const tenantPackCreditsField = (
  condition?: (data: Record<string, unknown>) => boolean,
): Field => ({
  name: 'packCreditsUsableAt',
  type: 'select',
  defaultValue: DEFAULT_PACK_CREDIT_MODE,
  options: PACK_CREDIT_MODES.map((value) => ({ label: PACK_CREDIT_MODE_LABELS[value], value })),
  admin: {
    ...(condition ? { condition } : {}),
    description:
      'When a job pack’s credits become usable: once the order is paid (the old site’s rule), or as soon as it is invoiced.',
  },
})

/** The order statuses that may grant a pack's credits in `mode`. */
export const packCreditsGrantingStatuses = (mode: PackCreditMode): readonly string[] =>
  mode === 'on_invoice' ? ['invoiced', 'paid'] : ['paid']

/** Why `status` may not grant in `mode`, or `null` when it may. */
export const packCreditGrantProblem = ({
  mode,
  status,
}: {
  mode: PackCreditMode
  status: unknown
}): null | string => {
  const value = String(status ?? '')
  if (packCreditsGrantingStatuses(mode).includes(value)) return null
  if (!value) return 'An order with no status grants no credits'
  return mode === 'on_payment'
    ? `A ${value} order grants no credits: this site grants pack credits when the order is paid`
    : `A ${value} order grants no credits`
}

type SettingsContext = {
  settingsSlug: string
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}

type PluginCustom = {
  payloadJobs?: {
    registry?: { context?: Partial<SettingsContext> }
  }
}

const hasCollection = (payload: Payload, slug: string): boolean =>
  Boolean((payload.collections as Record<string, unknown> | undefined)?.[slug])

const hasGlobal = (payload: Payload, slug: string): boolean =>
  Boolean((payload.config.globals as { slug?: string }[] | undefined)?.some((global) => global.slug === slug))

/** Where the setting lives, from what the plugin recorded on the config, or the defaults. */
const settingsContextFor = (payload: Payload): SettingsContext => {
  const context = (payload.config.custom as PluginCustom | undefined)?.payloadJobs?.registry?.context
  return {
    settingsSlug: context?.settingsSlug ?? 'job-board-settings',
    tenancy: context?.tenancy ?? 'multi',
    tenantsSlug: context?.tenantsSlug ?? 'tenants',
  }
}

/**
 * The mode the order's tenant uses. A missing tenant, collection or global (a minimal config, a
 * test boot without the setting) means the default, `on_payment`, never a guess.
 */
export const packCreditModeForOrder = async ({
  order,
  payload,
  req,
}: {
  order: Record<string, unknown> & { tenant?: unknown }
  payload: Payload
  req?: PayloadRequest
}): Promise<PackCreditMode> => {
  const { settingsSlug, tenancy, tenantsSlug } = settingsContextFor(payload)

  if (tenancy === 'single') {
    if (!hasGlobal(payload, settingsSlug)) return DEFAULT_PACK_CREDIT_MODE
    const settings = (await payload.findGlobal({
      depth: 0,
      overrideAccess: true,
      req,
      slug: settingsSlug as GlobalSlug,
    })) as TenantPackCreditSource
    return tenantPackCreditMode(settings)
  }

  const tenantID = tenantIDOf(order.tenant)
  if (tenantID === null || !hasCollection(payload, tenantsSlug)) return DEFAULT_PACK_CREDIT_MODE
  const tenant = (await payload.findByID({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    id: tenantID,
    overrideAccess: true,
    req,
  })) as TenantPackCreditSource
  return tenantPackCreditMode(tenant)
}
