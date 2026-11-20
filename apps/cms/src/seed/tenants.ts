import { randomUUID } from 'node:crypto'

import { getPayload } from 'payload'

import config from '../payload.config'

type SeedTenant = {
  adminEmail?: string
  branding?: {
    colorAccent?: string
    colorHover?: string
    colorPrimary?: string
  }
  currency?: string
  currencyMinorUnits?: number
  defaultLocale?: string
  domains: { domain: string }[]
  emailFromAddress?: string
  emailFromName?: string
  isAggregate: boolean
  locales?: { locale: string }[]
  locationLevels?: string[]
  locationMaxDepth?: number
  name: string
  slug: string
  taxLabel?: string
  timezone?: string
}

// Pacific Jobs is the aggregate/hub tenant: no site settings, no currency or locale.
// Vanuatu Wok is the first paid site. Email addresses use .invalid so a mistaken
// seed can never send mail. Its logo is intentionally left for the R2/media task.
const seedTenants: SeedTenant[] = [
  {
    domains: [],
    isAggregate: true,
    name: 'Pacific Jobs',
    slug: 'pacific-jobs',
  },
  {
    adminEmail: 'admin@vanuatuwok.invalid',
    branding: {
      colorAccent: '#dd3333',
      colorHover: '#0066bf',
      colorPrimary: '#06914b',
    },
    currency: 'VUV',
    currencyMinorUnits: 0,
    defaultLocale: 'en',
    domains: [{ domain: 'vanuatuwok.vu' }, { domain: 'www.vanuatuwok.vu' }],
    emailFromAddress: 'noreply@vanuatuwok.invalid',
    emailFromName: 'Vanuatu Wok',
    isAggregate: false,
    locales: [{ locale: 'en' }],
    locationLevels: ['Island', 'Town'],
    locationMaxDepth: 1,
    name: 'Vanuatu Wok',
    slug: 'vwok',
    taxLabel: 'VAT',
    timezone: 'Pacific/Efate',
  },
]

if (process.env.SEED_TENANTS_CONFIRM !== '1') {
  throw new Error('Refusing to seed tenants. Set SEED_TENANTS_CONFIRM=1 for the intended database.')
}

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

const payload = await getPayload({ config })
const pool = (payload.db as unknown as { pool: Queryable }).pool
const client = await (pool as unknown as { connect: () => Promise<Queryable & { release: () => void }> }).connect()

try {
  await client.query('begin')

  for (const tenant of seedTenants) {
    const values = [
      tenant.name,
      tenant.slug,
      tenant.isAggregate,
      tenant.currency ?? null,
      tenant.currencyMinorUnits ?? null,
      tenant.timezone ?? null,
      tenant.defaultLocale ?? null,
      tenant.taxLabel ?? null,
      tenant.emailFromName ?? null,
      tenant.emailFromAddress ?? null,
      tenant.adminEmail ?? null,
      tenant.branding?.colorPrimary ?? null,
      tenant.branding?.colorAccent ?? null,
      tenant.branding?.colorHover ?? null,
      tenant.locationMaxDepth ?? null,
    ]

    const existing = await client.query('select id from tenants where slug = $1 limit 1', [tenant.slug])
    let id: unknown

    if (existing.rows.length > 0) {
      id = existing.rows[0]?.id
      await client.query(
        `update tenants set
          name = $2, is_aggregate = $3, currency = $4, currency_minor_units = $5,
          timezone = $6, default_locale = $7, tax_label = $8, email_from_name = $9,
          email_from_address = $10, admin_email = $11, branding_color_primary = $12,
          branding_color_accent = $13, branding_color_hover = $14, location_max_depth = $15,
          updated_at = now()
        where id = $1`,
        [id, ...values.slice(0, 1), ...values.slice(2)],
      )
      await client.query('delete from tenants_domains where _parent_id = $1', [id])
      await client.query('delete from tenant_locale_list where _parent_id = $1', [id])
      await client.query('delete from tenants_location_levels where _parent_id = $1', [id])
      console.log(`tenant ${tenant.slug}: updated`)
    } else {
      const inserted = await client.query(
        `insert into tenants (
          name, slug, is_aggregate, currency, currency_minor_units, timezone, default_locale,
          tax_label, email_from_name, email_from_address, admin_email,
          branding_color_primary, branding_color_accent, branding_color_hover, location_max_depth
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        returning id`,
        values,
      )
      id = inserted.rows[0]?.id
      console.log(`tenant ${tenant.slug}: created`)
    }

    for (const [index, domain] of tenant.domains.entries()) {
      await client.query(
        'insert into tenants_domains (_order, _parent_id, id, domain) values ($1, $2, $3, $4)',
        [index, id, randomUUID(), domain.domain],
      )
    }

    for (const [index, locale] of (tenant.locales ?? []).entries()) {
      await client.query(
        'insert into tenant_locale_list (_order, _parent_id, id, locale) values ($1, $2, $3, $4)',
        [index, id, randomUUID(), locale.locale],
      )
    }

    for (const [index, label] of (tenant.locationLevels ?? []).entries()) {
      await client.query(
        'insert into tenants_location_levels (_order, _parent_id, id, label) values ($1, $2, $3, $4)',
        [index, id, randomUUID(), label],
      )
    }
  }
  await client.query('commit')
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await payload.destroy()
}
