import type { CollectionConfig, CollectionSlug, Field, Payload } from 'payload'

import { tenantContentWriteAccess } from '../access'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'

export const EMAIL_SUPPRESSIONS_SLUG = 'email-suppressions'

export const SUPPRESSION_REASONS = ['bounce', 'complaint'] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

export type EmailSuppressionsOptions = {
  access?: CollectionAccess
  slug?: string
  tenantScoped?: boolean
}

/** Addresses compare case-insensitively and without surrounding space. */
export const normaliseAddress = (address: string): string => address.trim().toLowerCase()

const readOnly = { admin: { readOnly: true } } as const
/** Site staff only: super admins and tenant admins/editors. Employers and seekers are denied. */
const staff = tenantContentWriteAccess

/**
 * The per-tenant suppression list (PJ-107): addresses that hard-bounced or complained. The
 * system writes rows (`overrideAccess`); staff can read them and delete a row to lift the block.
 * One row per tenant and address; the same address on another tenant is unaffected.
 */
export const emailSuppressionsCollection = ({
  access,
  slug = EMAIL_SUPPRESSIONS_SLUG,
  tenantScoped = true,
}: EmailSuppressionsOptions = {}): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    { create: () => false, delete: staff, read: staff, update: () => false },
    access,
  ),
  admin: {
    defaultColumns: ['address', 'reason', 'suppressedAt'],
    description: 'Addresses we no longer email because they bounced or complained. Delete a row to email the address again.',
    group: 'Settings',
    useAsTitle: 'address',
  },
  defaultSort: '-suppressedAt',
  fields: [
    { name: 'address', type: 'text', required: true, index: true, ...readOnly },
    {
      name: 'reason',
      type: 'select',
      required: true,
      options: SUPPRESSION_REASONS.map((value) => ({ label: value, value })),
      ...readOnly,
    },
    { name: 'suppressedAt', type: 'date', required: true, ...readOnly },
  ] as Field[],
  indexes: tenantScoped ? [{ fields: ['tenant', 'address'], unique: true }] : [{ fields: ['address'], unique: true }],
  versions: false,
})

type TenantID = null | number | string

const scope = (tenantID: TenantID) => (tenantID === null ? [] : [{ tenant: { equals: tenantID } }])

/** Is this tenant not emailing this address? (`tenantID` null for a single-tenant site.) */
export const isEmailSuppressed = async ({
  address,
  payload,
  slug = EMAIL_SUPPRESSIONS_SLUG,
  tenantID,
}: {
  address: string
  payload: Payload
  slug?: string
  tenantID: TenantID
}): Promise<boolean> => {
  const { totalDocs } = await payload.count({
    collection: slug as CollectionSlug,
    overrideAccess: true,
    where: { and: [...scope(tenantID), { address: { equals: normaliseAddress(address) } }] },
  })

  return totalDocs > 0
}

/** Suppress an address for a tenant. Idempotent: the first reason is kept. */
export const suppressAddress = async ({
  address,
  now = new Date(),
  payload,
  reason,
  slug = EMAIL_SUPPRESSIONS_SLUG,
  tenantID,
}: {
  address: string
  now?: Date
  payload: Payload
  reason: SuppressionReason
  slug?: string
  tenantID: TenantID
}): Promise<boolean> => {
  if (await isEmailSuppressed({ address, payload, slug, tenantID })) return false

  await payload.create({
    collection: slug as CollectionSlug,
    data: {
      address: normaliseAddress(address),
      reason,
      suppressedAt: now.toISOString(),
      ...(tenantID === null ? {} : { tenant: tenantID }),
    } as never,
    overrideAccess: true,
  })

  return true
}
