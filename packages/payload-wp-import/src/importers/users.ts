import { randomUUID } from 'node:crypto'

import { legacySlug, legacySlugPart, legacyText } from '../legacy-text'
import type { MysqlReader } from '../mysql-reader'
import type { Importer, MappedDoc, SkippedRow } from '../types'

/**
 * Import of the active WordPress users, their organisations and their password hashes (PJ-62).
 *
 * JobRoller has no organisation entity: an organisation is a `job_lister` user plus user meta
 * (AUDIT.md). So both importers read the same legacy data and the organisations are derived:
 * every kept employer becomes a member of an organisation named by their `nickname`, employers
 * with the same normalised name share one organisation, and the lowest legacy user id of a
 * group is its owner. Nothing here reads applications, CVs, resumes, logs or `user_IP`.
 */

export type UserImportOptions = {
  /** An organisation page stays public when it was public on the legacy site. Default true. */
  keepPageVisibility?: boolean
  /** A job or order authored on or after this date keeps its author. Default `2022-01-01`. */
  activeJobsSince?: string
  /** A login within this many years keeps the user. Default 3. */
  activeLoginYears?: number
  /** Slug of the organisations collection (the plugin resolves it). Default `organisations`. */
  organisationsSlug?: string
  /** Clock, for tests. */
  now?: () => Date
  /**
   * Where the plan comes from. The job importer (PJ-64) shares the plan of the users importers,
   * so both agree on which organisations exist. Default: one built per reader.
   */
  planProvider?: PlanProvider
  /** Slug of the users collection. Default `users`. */
  usersSlug?: string
}

/** Legacy user meta read by this importer. `capabilities` is prefixed (`wp_capabilities`). */
const META_KEYS = [
  'last_login',
  'jr_alert_status',
  'confirmation_key',
  'first_name',
  'last_name',
  'nickname',
  'description',
  'organisation_type',
  'organisation_size',
  'phone_number',
  'area_code',
  'twitter_id',
  'facebook_id',
  'linkedin_profile',
  'enable_organisations_page',
  'listing_request',
  'can_pay_by_bank_transfer',
  'can_pay_by_bank_transfer_billing_email',
  'xero_contact_code',
] as const

export type LegacyUser = {
  ID: number
  display_name?: null | string
  user_email?: null | string
  user_pass?: null | string
  user_url?: null | string
}

export type LegacyUserFacts = {
  /** The user authored a job or an order on or after the cut-off date. */
  hasRecentJobOrOrder: boolean
  meta: Record<string, string>
  roles: string[]
  user: LegacyUser
}

export type TenantRole = 'employer' | 'seeker' | 'tenant-admin'

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/** Role names out of a serialized PHP array such as `a:1:{s:10:"job_lister";b:1;}`. */
export const parseCapabilities = (value: null | string | undefined): string[] =>
  [...String(value ?? '').matchAll(/s:\d+:"([^"]+)";b:1;/g)].map((match) => match[1]!)

const isStaff = (roles: readonly string[]): boolean =>
  roles.includes('administrator') || roles.includes('editor')

/** Legacy roles → the user's role in the tenant. `null` for a role the platform has no use for. */
export const tenantRoleFor = (roles: readonly string[]): null | TenantRole => {
  // Site managers: the legacy admins and editors (no separate content editor in the MVP).
  if (isStaff(roles)) return 'tenant-admin'
  if (roles.includes('job_lister') || roles.includes('recruiter')) return 'employer'
  if (roles.includes('job_seeker') || roles.includes('contributor')) return 'seeker'
  return null
}

/** The `last_login` meta as a date. WordPress themes store a date string or a unix timestamp. */
export const parseLastLogin = (value: null | string | undefined): Date | null => {
  const text = String(value ?? '').trim()
  if (!text) return null
  const date = /^\d{9,11}$/.test(text)
    ? new Date(Number(text) * 1000)
    : new Date(/^\d{4}-\d{2}-\d{2} /.test(text) ? `${text.replace(' ', 'T')}Z` : text)
  return Number.isNaN(date.getTime()) ? null : date
}

export type ActiveReason = 'admin' | 'alert' | 'job' | 'login'

/**
 * Why a user counts as active, or `[]` when they do not. Active = logged in within N years, OR
 * authored a job/order since the cut-off, OR has an alert subscription, OR is an admin/editor.
 * Both date bounds are inclusive: a login exactly N years ago, or a job dated exactly on the
 * cut-off day, still counts.
 */
export const activeReasons = (
  facts: LegacyUserFacts,
  options: Required<Pick<UserImportOptions, 'activeJobsSince' | 'activeLoginYears'>> & { now: Date },
): ActiveReason[] => {
  const reasons: ActiveReason[] = []

  const login = parseLastLogin(facts.meta.last_login)
  if (login) {
    const cutoff = new Date(options.now)
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - options.activeLoginYears)
    if (login.getTime() >= cutoff.getTime()) reasons.push('login')
  }
  if (facts.hasRecentJobOrOrder) reasons.push('job')
  if (facts.meta.jr_alert_status === 'active') reasons.push('alert')
  if (isStaff(facts.roles)) reasons.push('admin')

  return reasons
}

/** Meta stored by a checkbox. A row that exists counts, unless it says no (`0`, `no`, `off`). */
export const isFlagSet = (value: null | string | undefined): boolean =>
  value !== undefined && value !== null && !/^(0|no|false|off)$/i.test(value.trim())

/**
 * One name for duplicates to share: case, accents, punctuation and spacing are ignored, and `&`
 * reads as `and`. Deliberately not smarter (no "Ltd" stripping): a wrong merge is worse than a
 * duplicate that a site manager can merge. The job importer reuses this for `_Company`.
 */
export const normaliseOrganisationName = (name: null | string | undefined): string =>
  legacyText(name)
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()

// ---------------------------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------------------------

const ORGANISATION_TYPES = [
  'business',
  'consultant',
  'government',
  'nfp',
  'recruiter',
  'social-enterprise',
] as const

const TYPE_ALIASES: Record<string, (typeof ORGANISATION_TYPES)[number]> = {
  company: 'business',
  govt: 'government',
  'non-profit': 'nfp',
  'not-for-profit': 'nfp',
  'not-for-profit-organisation': 'nfp',
  'recruitment-agency': 'recruiter',
}

export const mapOrganisationType = (value: null | string | undefined): string | undefined => {
  const slug = legacySlugPart(value)
  if (!slug) return undefined
  const type = TYPE_ALIASES[slug] ?? slug
  return (ORGANISATION_TYPES as readonly string[]).includes(type) ? type : undefined
}

/** The legacy size bands (nine, free labels) onto the five the directory filters on. */
export const mapOrganisationSize = (value: null | string | undefined): string | undefined => {
  const numbers = [...String(value ?? '').replaceAll(',', '').matchAll(/\d+/g)].map((m) => Number(m[0]))
  if (numbers.length === 0) return undefined
  // The upper bound of a band such as "11-50"; the only number of "500+" or "1".
  const bound = numbers.length > 1 ? Math.max(...numbers) : numbers[0]!
  if (/\+|more|over/i.test(String(value)) && numbers.length === 1 && bound >= 500) return '500-plus'
  if (bound <= 10) return '1-10'
  if (bound <= 50) return '11-50'
  if (bound <= 200) return '51-200'
  if (bound <= 500) return '201-500'
  return '500-plus'
}

/** An http(s) URL, adding `https://` to a bare domain. `undefined` for anything else. */
export const cleanUrl = (value: null | string | undefined): string | undefined => {
  const text = String(value ?? '').trim()
  if (!text || /\s/.test(text)) return undefined
  const url = /^https?:\/\//i.test(text) ? text : `https://${text}`
  return /^https?:\/\/[^/.\s]+\.[^/\s]+/i.test(url) ? url : undefined
}

export const cleanEmail = (value: null | string | undefined): string | undefined => {
  const text = String(value ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : undefined
}

const first = <T>(values: (T | undefined)[]): T | undefined => values.find((v) => v !== undefined)

type OrganisationFields = {
  about?: string
  billingEmail?: string
  canPayByInvoice: boolean
  listingRequested: boolean
  pageEnabled: boolean
  phone?: string
  size?: string
  socials?: Record<string, string>
  type?: string
  website?: string
  xeroContactCode?: string
}

/** One legacy user's meta as organisation fields. Empty values are left out. */
const organisationFieldsOf = (facts: LegacyUserFacts): OrganisationFields => {
  const { meta, user } = facts
  const text = (key: string) => legacyText(meta[key]) || undefined
  const phone = [text('area_code'), text('phone_number')].filter(Boolean).join(' ').trim() || undefined

  const socials = Object.fromEntries(
    Object.entries({
      facebook: cleanUrl(meta.facebook_id),
      linkedin: cleanUrl(meta.linkedin_profile),
      x: cleanUrl(meta.twitter_id),
    }).filter(([, url]) => url),
  ) as Record<string, string>

  return {
    about: text('description'),
    billingEmail: cleanEmail(meta.can_pay_by_bank_transfer_billing_email),
    // `can_pay_by_bank_transfer` is the legacy "trusted" flag: invoice-me, publish before payment.
    canPayByInvoice: isFlagSet(meta.can_pay_by_bank_transfer),
    listingRequested: isFlagSet(meta.listing_request),
    pageEnabled: isFlagSet(meta.enable_organisations_page),
    phone,
    size: mapOrganisationSize(meta.organisation_size),
    socials: Object.keys(socials).length > 0 ? socials : undefined,
    type: mapOrganisationType(meta.organisation_type),
    website: cleanUrl(user.user_url),
    xeroContactCode: text('xero_contact_code'),
  }
}

// ---------------------------------------------------------------------------------------------
// Plan: who is kept, and which organisation each kept employer belongs to
// ---------------------------------------------------------------------------------------------

export type OrganisationGroup = {
  /** Every kept employer with this name, lowest id first. The first is the owner. */
  members: LegacyUserFacts[]
  name: string
  slug: string
}

export type PlanProvider = (reader: MysqlReader) => Promise<ImportPlan>

/** A plan provider that builds the plan once per reader and hands the same one to every caller. */
export const createPlanProvider = (options: UserImportOptions = {}): PlanProvider => {
  let cached: { plan: Promise<ImportPlan>; reader: MysqlReader } | undefined
  return (reader) => {
    if (!cached || cached.reader !== reader) cached = { plan: buildImportPlan(reader, options), reader }
    return cached.plan
  }
}

export type ImportPlan = {
  groups: OrganisationGroup[]
  /** Kept employers: legacy user id → the legacy id of their organisation (its owner's id). */
  organisationOf: Map<number, { organisationLegacyId: number; owner: boolean }>
  /** Counts for the dry-run report. */
  report: { employersKept: number; organisations: number; organisationsMerged: number; usersKept: number; usersRead: number }
  users: Map<number, { reasons: ActiveReason[]; skip?: string; role: null | TenantRole; facts: LegacyUserFacts }>
}

const organisationNameOf = (facts: LegacyUserFacts): string =>
  legacyText(facts.meta.nickname) || legacyText(facts.user.display_name)

/**
 * Read the legacy users and decide, in memory, everything both importers need. 15,844 users and
 * their meta are a few tens of megabytes. Pure apart from the reads, so the report of a dry run
 * and the real run agree.
 */
export const buildImportPlan = async (
  reader: MysqlReader,
  options: UserImportOptions = {},
): Promise<ImportPlan> => {
  const rules = {
    activeJobsSince: options.activeJobsSince ?? '2022-01-01',
    activeLoginYears: options.activeLoginYears ?? 3,
    now: (options.now ?? (() => new Date()))(),
  }
  const capabilitiesKey = `${reader.prefix}capabilities`

  const metaByUser = new Map<number, Record<string, string>>()
  for await (const row of reader.rows<Record<string, unknown>>('usermeta', {
    key: 'umeta_id',
    params: [capabilitiesKey, ...META_KEYS],
    where: `meta_key IN (${[capabilitiesKey, ...META_KEYS].map(() => '?').join(', ')})`,
  })) {
    const id = Number(row.user_id)
    const meta = metaByUser.get(id) ?? {}
    // WordPress allows duplicate meta rows; the last one wins, as `get_user_meta(..., true)` does.
    meta[String(row.meta_key)] = String(row.meta_value ?? '')
    metaByUser.set(id, meta)
  }

  const recentAuthors = new Set<number>()
  for await (const row of reader.rows<Record<string, unknown>>('posts', {
    params: ['job_listing', 'transaction'],
    where: 'post_type IN (?, ?)',
  })) {
    if (String(row.post_date ?? '') >= rules.activeJobsSince) recentAuthors.add(Number(row.post_author))
  }

  const plan: ImportPlan = {
    groups: [],
    organisationOf: new Map(),
    report: { employersKept: 0, organisations: 0, organisationsMerged: 0, usersKept: 0, usersRead: 0 },
    users: new Map(),
  }
  const kept: LegacyUserFacts[] = []

  for await (const user of reader.rows<LegacyUser & Record<string, unknown>>('users')) {
    plan.report.usersRead++
    const meta = metaByUser.get(user.ID) ?? {}
    const facts: LegacyUserFacts = {
      hasRecentJobOrOrder: recentAuthors.has(user.ID),
      meta,
      roles: parseCapabilities(meta[capabilitiesKey]),
      user,
    }
    const role = tenantRoleFor(facts.roles)
    const reasons = activeReasons(facts, rules)

    let skip: string | undefined
    if (reasons.length === 0) skip = 'inactive'
    else if (!role) skip = 'unsupported-role'
    else if (!cleanEmail(user.user_email)) skip = 'invalid-email'
    else if (role === 'employer' && !organisationNameOf(facts)) skip = 'no-organisation-name'
    else if (role === 'employer' && !normaliseOrganisationName(organisationNameOf(facts))) skip = 'no-organisation-name'

    plan.users.set(user.ID, { facts, reasons, role, skip })
    if (!skip) kept.push(facts)
  }
  plan.report.usersKept = kept.length

  // Group kept employers by organisation name, in user id order so the owner is the first.
  const byName = new Map<string, LegacyUserFacts[]>()
  for (const facts of [...kept].sort((a, b) => a.user.ID - b.user.ID)) {
    if (plan.users.get(facts.user.ID)?.role !== 'employer') continue
    const key = normaliseOrganisationName(organisationNameOf(facts))
    byName.set(key, [...(byName.get(key) ?? []), facts])
  }

  const usedSlugs = new Set<string>()
  for (const members of byName.values()) {
    const owner = members[0]!
    const name = organisationNameOf(owner)
    const base = legacySlug(name) ?? `organisation-${owner.user.ID}`
    const slug = usedSlugs.has(base) ? `${base}-${owner.user.ID}` : base
    usedSlugs.add(slug)

    plan.groups.push({ members, name, slug })
    for (const member of members) {
      plan.organisationOf.set(member.user.ID, {
        organisationLegacyId: owner.user.ID,
        owner: member === owner,
      })
    }
    plan.report.employersKept += members.length
    plan.report.organisationsMerged += members.length - 1
  }
  plan.report.organisations = plan.groups.length

  return plan
}

/** An organisation from its group: the owner's fields, gaps filled from the other members. */
export const mapOrganisationGroup = (
  group: OrganisationGroup,
  options: Pick<UserImportOptions, 'keepPageVisibility'> = {},
): MappedDoc => {
  const fields = group.members.map(organisationFieldsOf)
  const pick = <K extends keyof OrganisationFields>(key: K) => first(fields.map((f) => f[key]))
  // A flag any account of the merged organisation had keeps it (the legacy site honoured each).
  const any = (key: 'canPayByInvoice' | 'listingRequested' | 'pageEnabled') => fields.some((f) => f[key])

  const pageEnabled = (options.keepPageVisibility ?? true) ? any('pageEnabled') : false
  const type = group.members.some((m) => m.roles.includes('recruiter')) ? 'recruiter' : pick('type')
  const data: Record<string, unknown> = {
    canPayByInvoice: any('canPayByInvoice'),
    listingRequested: any('listingRequested'),
    name: group.name,
    // Pages are private by default; an organisation that was public stays public (a setting).
    pageEnabled,
    // The collection shows a page only when it is both approved and enabled, so a page that was
    // public on the legacy site is approved too. A tenant that resets visibility imports neither.
    approved: pageEnabled,
    slug: group.slug,
  }
  for (const [key, value] of Object.entries({
    about: pick('about'),
    billingEmail: pick('billingEmail'),
    phone: pick('phone'),
    size: pick('size'),
    socials: pick('socials'),
    type,
    website: pick('website'),
    xeroContactCode: pick('xeroContactCode'),
  })) {
    if (value !== undefined) data[key] = value
  }

  return { data, legacyId: group.members[0]!.user.ID }
}

// ---------------------------------------------------------------------------------------------
// Importers
// ---------------------------------------------------------------------------------------------

/**
 * The two importers share one plan per reader. `organisations` must run first so the users can
 * point at them; `dependsOn` guarantees it.
 */
export const usersImporters = (
  options: UserImportOptions = {},
): { organisations: Importer<OrganisationGroup>; users: Importer<LegacyUserFacts> } => {
  const organisationsSlug = options.organisationsSlug ?? 'organisations'
  const provider = options.planProvider ?? createPlanProvider(options)
  let lastPlan: ImportPlan | undefined

  const planFor = (reader: MysqlReader): Promise<ImportPlan> =>
    provider(reader).then((plan) => (lastPlan = plan))

  const organisations: Importer<OrganisationGroup> = {
    collection: organisationsSlug,
    dependsOn: [],
    map: (group) => mapOrganisationGroup(group, options),
    name: 'organisations',
    read: async function* (reader) {
      yield* (await planFor(reader)).groups
    },
    report: () => ({
      'legacy users read': lastPlan?.report.usersRead ?? 0,
      'legacy employers merged into another organisation': lastPlan?.report.organisationsMerged ?? 0,
      'organisations to import': lastPlan?.report.organisations ?? 0,
    }),
  }

  const users: Importer<LegacyUserFacts> = {
    collection: options.usersSlug ?? 'users',
    dependsOn: ['organisations'],
    map: async (facts, ctx): Promise<MappedDoc | SkippedRow> => {
      const decision = lastPlan?.users.get(facts.user.ID)
      if (!decision) return { skip: 'not-in-plan' }
      if (decision.skip) return { skip: decision.skip }

      const email = cleanEmail(facts.user.user_email)!
      const membership = lastPlan!.organisationOf.get(facts.user.ID)
      let organisation: number | string | undefined
      if (membership) {
        // In a dry run the organisation does not exist yet, so the link stays empty.
        const found = await ctx.payload.find({
          collection: organisationsSlug,
          depth: 0,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          where: {
            and: [
              { legacyId: { equals: membership.organisationLegacyId } },
              { tenant: { equals: ctx.tenant } },
            ],
          },
        })
        organisation = found.docs[0]?.id
      }

      const hash = String(facts.user.user_pass ?? '').trim()
      const confirmed = !facts.meta.confirmation_key || Boolean(parseLastLogin(facts.meta.last_login))
      const names = {
        firstName: legacyText(facts.meta.first_name) || undefined,
        lastName: legacyText(facts.meta.last_name) || undefined,
      }

      return {
        // Only these follow a re-run. Credentials, memberships and the role stay as the user and
        // the site managers have since changed them.
        data: names,
        legacyId: facts.user.ID,
        // Sync only: follow a changed WordPress password until the user signs in.
        ...(hash ? { refreshWhileSet: { legacyPasswordHash: hash } } : {}),
        // Created through the adapter: no hooks, and no Payload password. The account signs in
        // with its WordPress password (PJ-34), which is then rehashed and the hash cleared.
        rawCreate: true,
        createOnly: {
          _verified: confirmed,
          email,
          legacyPasswordHash: hash || null,
          loginAttempts: 0,
          ...(organisation === undefined
            ? {}
            : { organisation, organisationRole: membership?.owner ? 'owner' : 'member' }),
          role: 'user',
          // Created through the adapter, so the array row needs the id Payload's hooks would give it.
          tenants: [{ id: randomUUID(), role: decision.role, tenant: ctx.tenant }],
        },
      }
    },
    name: 'users',
    read: async function* (reader) {
      const plan = await planFor(reader)
      for (const { facts } of plan.users.values()) yield facts
    },
    report: () => ({
      'legacy users kept': lastPlan?.report.usersKept ?? 0,
      'legacy users read': lastPlan?.report.usersRead ?? 0,
    }),
    tenantScope: { path: 'tenants.tenant', set: false },
  }

  return { organisations, users }
}
