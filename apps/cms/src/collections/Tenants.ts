import type { CollectionBeforeDeleteHook, CollectionConfig } from 'payload'

import { authenticatedAccess, superAdminAccess } from '@mission-control/payload-jobs'

// Job-board settings (currency, timezone, locales, email sender) are added to this
// collection by @mission-control/payload-jobs in multi-tenant mode.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const validateHexColor = (value: null | string | undefined): string | true =>
  value === null || value === undefined || value === '' || HEX_COLOR.test(value)
    ? true
    : 'Use a hex colour, for example #06914b'

const validateSlug = (value: null | string | undefined): string | true =>
  value && SLUG.test(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example vanuatu-wok'

type TenantMembership = { role?: unknown; tenant?: unknown }

/**
 * Remove user memberships before the tenant row is deleted. The users_tenants.tenant_id
 * column is NOT NULL, so the relationship's ON DELETE SET NULL would otherwise make a
 * tenant delete fail while memberships exist.
 */
export const removeTenantMemberships: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const users = await req.payload.find({
    collection: 'users',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      'tenants.tenant': {
        in: [id],
      },
    },
  })

  await Promise.all(
    users.docs.map((user) => {
      const memberships = (user as { tenants?: null | TenantMembership[] }).tenants ?? []

      return req.payload.update({
        id: user.id,
        collection: 'users',
        data: {
          tenants: memberships.filter((membership) => String(membership.tenant) !== String(id)),
        } as never,
        overrideAccess: true,
        req,
      })
    }),
  )
}

/**
 * Delete a tenant's site keys before the tenant row is deleted. site_keys.tenant_id is
 * NOT NULL, so the relationship's ON DELETE SET NULL would otherwise make a tenant delete
 * fail while keys exist.
 */
export const removeTenantSiteKeys: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'site-keys',
    overrideAccess: true,
    req,
    where: {
      tenant: {
        equals: id,
      },
    },
  })
}

export const Tenants: CollectionConfig = {
  slug: 'tenants',
  admin: {
    defaultColumns: ['name', 'slug', 'isAggregate'],
    group: 'Tenants',
    useAsTitle: 'name',
  },
  access: {
    create: superAdminAccess,
    delete: superAdminAccess,
    read: authenticatedAccess,
    update: superAdminAccess,
  },
  hooks: {
    beforeDelete: [removeTenantMemberships, removeTenantSiteKeys],
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: validateSlug,
    },
    {
      name: 'domains',
      type: 'array',
      fields: [
        {
          name: 'domain',
          type: 'text',
          required: true,
        },
      ],
    },
    {
      name: 'isAggregate',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description: 'Aggregate tenants can read published content from every tenant.',
      },
    },
    {
      name: 'branding',
      type: 'group',
      fields: [
        {
          name: 'logo',
          type: 'upload',
          relationTo: 'media',
        },
        {
          name: 'colorPrimary',
          type: 'text',
          validate: validateHexColor,
        },
        {
          name: 'colorAccent',
          type: 'text',
          validate: validateHexColor,
        },
        {
          name: 'colorHover',
          type: 'text',
          validate: validateHexColor,
        },
      ],
    },
  ],
  versions: false,
}
