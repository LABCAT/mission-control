import type { CollectionConfig, Config, Plugin } from 'payload'

import {
  addOnWriteGuard,
  gateCollectionAccess,
  getPayloadJobsRegistry,
  tenantCleanup,
  type CollectionAccess,
} from '@mission-control/payload-jobs'

import { alertEndpoints, type AlertEndpointsOptions } from './endpoints'
import { ALERT_EMAIL_EVENT_DEFINITIONS } from './email'
import { alertSettingsFields } from './settings'
import { ALERTS_ADD_ON_KEY } from './service'
import {
  ALERT_SUBSCRIPTIONS_SLUG,
  alertSubscriptionCollection,
  removeTenantAlertSubscriptions,
  removeTenantAlertSubscriptionsFor,
} from './subscriptions'

export * from './subscriptions'
export * from './email'
export * from './endpoints'
export * from './filters'
export * from './service'
export * from './settings'
export * from './tokens'

export type PayloadJobsAlertsOptions = Omit<AlertEndpointsOptions, 'alertsSlug' | 'slugs' | 'tenantsSlug'> & {
  /** Overrides the collection's access, operation by operation (before the add-on gate). */
  access?: CollectionAccess
  /** Turn the add-on off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /** Collection slug (PJ-80 style). Defaults to `alert-subscriptions`. */
  slug?: string
}

/**
 * Job alerts add-on (PJ-26, moved here by PJ-115). List it after `payloadJobs()`. The
 * collection, fields and slug are exactly what core used to add, so there is no schema change.
 * A tenant that leaves `alerts` out of its `addOns` setting sees no subscribers and can add none.
 *
 * In multi-tenant mode the host lists the collection in the multi-tenant plugin's `collections`;
 * `alertsTenantCollections(options)` returns its slug.
 */
export const alertsTenantCollections = (options: PayloadJobsAlertsOptions = {}): string[] => [
  options.slug ?? ALERT_SUBSCRIPTIONS_SLUG,
]

export const payloadJobsAlerts =
  (options: PayloadJobsAlertsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const registry = getPayloadJobsRegistry(incoming)
    const { slugs, tenancy, tenantsSlug } = registry.context
    const slug = options.slug ?? ALERT_SUBSCRIPTIONS_SLUG
    const tenantScoped = tenancy === 'multi'

    if ((incoming.collections ?? []).some((collection) => collection.slug === slug)) {
      throw new Error(`payload-jobs-alerts: a "${slug}" collection already exists.`)
    }

    registry.addOns.register({
      collections: [slug],
      description: 'Email-only job alerts with double opt-in.',
      key: ALERTS_ADD_ON_KEY,
      label: 'Job alerts',
    })

    // The events and variables PJ-50/PJ-51 build templates for.
    for (const event of ALERT_EMAIL_EVENT_DEFINITIONS) {
      registry.emailEvents.register({
        ...event,
        blocks: [],
        recipients: [...event.recipients],
        variables: [...event.variables],
      })
    }

    const gate = { key: ALERTS_ADD_ON_KEY, registry }
    const base = alertSubscriptionCollection({ access: options.access, slug, slugs, tenantScoped })
    const access = base.access ?? {}
    const collection: CollectionConfig = {
      ...base,
      // Create stays denied by the base access; read, update and delete are gate-narrowed.
      access: {
        ...access,
        delete: access.delete && gateCollectionAccess(gate, access.delete),
        read: access.read && gateCollectionAccess(gate, access.read),
        update: access.update && gateCollectionAccess(gate, access.update),
      },
      hooks: {
        ...base.hooks,
        beforeValidate: [...(base.hooks?.beforeValidate ?? []), addOnWriteGuard(gate)],
      },
    }

    // Deleting a tenant must take its subscribers with it, not detach them. This runs whether
    // or not the tenant has the add-on on. The cleanup marker tells the tenant data guard
    // (PJ-93) that these rows never outlive the tenant, so they never block its deletion; the
    // marker matters because this plugin appends after the guard.
    const removeSubscribers = tenantCleanup(
      [slug],
      slug === ALERT_SUBSCRIPTIONS_SLUG
        ? removeTenantAlertSubscriptions
        : removeTenantAlertSubscriptionsFor(slug),
    )

    // The public endpoints live on the tenants collection, like the account and form ones, and
    // the per-tenant settings are fields on it (or on the settings global of a single site).
    const endpoints = alertEndpoints({
      ...options,
      alertsSlug: slug,
      slugs,
      tenantsSlug,
    })

    return {
      ...incoming,
      collections: [
        ...(incoming.collections ?? []).map((existing) =>
          tenantScoped && existing.slug === tenantsSlug
            ? {
                ...existing,
                endpoints: [...(Array.isArray(existing.endpoints) ? existing.endpoints : []), ...endpoints],
                fields: [...existing.fields, ...alertSettingsFields()],
                hooks: {
                  ...existing.hooks,
                  beforeDelete: [...(existing.hooks?.beforeDelete ?? []), removeSubscribers],
                },
              }
            : existing,
        ),
        collection,
      ],
      ...(tenantScoped
        ? {}
        : {
            globals: (incoming.globals ?? []).map((global) =>
              global.slug === registry.context.settingsSlug
                ? { ...global, fields: [...global.fields, ...alertSettingsFields()] }
                : global,
            ),
          }),
    }
  }
