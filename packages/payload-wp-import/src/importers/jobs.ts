import { randomUUID } from 'node:crypto'

import { htmlToLexical, htmlToPlainText } from '../html-to-lexical'
import { legacySlugPart, legacySlug, legacyText } from '../legacy-text'
import type { MysqlReader } from '../mysql-reader'
import type { ImportContext, Importer, MappedDoc, SkippedRow } from '../types'
import { buildJobLocationMatcher, jobAddressLabel, type JobLocationMatcher, type JobLocationOptions } from './job-locations'
import type { LocationDoc } from './locations'
import { importableTerms, LEGACY_TAXONOMY_KEYS, readTaxonomyTerms, type LegacyTerm } from './taxonomies'
import { cleanEmail, cleanUrl, normaliseOrganisationName, type ImportPlan, type PlanProvider } from './users'

/**
 * Import of the legacy published and expired jobs (PJ-64).
 *
 * Two importers share one read of the legacy jobs: `job-organisations` creates the organisations
 * that exist only as a job's `_Company` name (admins post about two thirds of the jobs, with the
 * real employer typed into `_Company`), and `jobs` writes the jobs. Both are idempotent by
 * `legacyId` and tenant. Nothing here reads `user_IP`, applications, CVs or alerts.
 */

export type JobsImportOptions = {
  /** Close the job this many days after it was published when the legacy job has no duration. Default 30. */
  defaultDurationDays?: number
  /** Seed `featured-in-category` placements too. Default false (vwok does not use it). */
  featuredInCategory?: boolean
  location?: JobLocationOptions
  /** Collection slugs, as the plugin resolves them. */
  slugs?: Partial<JobSlugs>
  /** Clock, for tests. Placements that have already ended are not imported. */
  now?: () => Date
  /** The users plan (PJ-62), so jobs and organisations agree on who exists. */
  planProvider: PlanProvider
  /** Words a job slug may never be. Default: the plugin's reserved list. */
  reservedSlugs?: readonly string[]
  /** `post_date` is site-local; used only when `post_date_gmt` is empty. Minutes east of UTC. Default 0. */
  siteUtcOffsetMinutes?: number
}

export type JobSlugs = {
  jobCategories: string
  jobTypes: string
  jobs: string
  locations: string
  organisations: string
  salaryBands: string
}

const DEFAULT_SLUGS: JobSlugs = {
  jobCategories: 'job-categories',
  jobTypes: 'job-types',
  jobs: 'jobs',
  locations: 'locations',
  organisations: 'organisations',
  salaryBands: 'salary-bands',
}

const DEFAULT_RESERVED = ['account', 'admin', 'all', 'api', 'feed', 'in', 'jobs', 'login', 'new', 'page', 'rss', 'search', 'sitemap']

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

/** Legacy `post_status` → job status. Anything else (draft, pending, trash, auto-draft) is not imported. */
export const importableStatus = (postStatus: string): 'expired' | 'published' | null =>
  postStatus === 'publish' ? 'published' : postStatus === 'expired' ? 'expired' : null

/** A checkbox saved by a plugin: `1`, `yes`, `on`, `true`. An empty or `0` value is off. */
export const isOn = (value: null | string | undefined): boolean => /^(1|yes|on|true)$/i.test(String(value ?? '').trim())

/** A positive whole number, or `null`. */
export const positiveInt = (value: null | string | undefined): null | number => {
  const n = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** A date from WordPress: `YYYY-MM-DD[ HH:MM:SS]` (read as UTC plus `offsetMinutes`), or a unix timestamp. */
export const parseLegacyDate = (value: null | string | undefined, offsetMinutes = 0): Date | null => {
  const text = String(value ?? '').trim()
  if (!text || text.startsWith('0000-00-00')) return null
  if (/^\d{9,11}$/.test(text)) return new Date(Number(text) * 1000)
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text)
  if (!match) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMinutes * 60_000
  return Number.isNaN(time) ? null : new Date(time)
}

/**
 * Salary and job-type clean-up (19 Nov decision). Keyed by the legacy term slug. A fold maps a
 * term onto the one it merges into; a drop is a broken term (a comma-formatted range cut in
 * pieces) that jobs must not link to.
 */
export const TERM_FOLDS: Record<'job-types' | 'salary-bands', Record<string, string>> = {
  'job-types': { independant: 'independent' },
  'salary-bands': {
    '1000000-1500000': '1000000-2000000',
    '1500000-2000000': '1000000-2000000',
  },
}
export const TERM_DROPS: Record<'job-types' | 'salary-bands', readonly string[]> = {
  'job-types': [],
  'salary-bands': ['000', '000-or-more', '1', '2'],
}

/**
 * The term a job links to: itself, the term it folds into, or `null` for a dropped term.
 * A fold whose target is missing keeps the original term rather than losing the data.
 */
export const canonicalTerm = (
  collection: 'job-categories' | 'job-types' | 'salary-bands',
  term: LegacyTerm,
  all: readonly LegacyTerm[],
): LegacyTerm | null => {
  if (collection === 'job-categories') return term
  const slug = legacySlugPart(term.slug) || legacySlugPart(term.name)
  if (TERM_DROPS[collection].includes(slug)) return null
  const target = TERM_FOLDS[collection][slug]
  if (!target) return term
  return all.find((candidate) => (legacySlugPart(candidate.slug) || legacySlugPart(candidate.name)) === target) ?? term
}

/** Close date: the employer's chosen days, else the plan's, else the default; never before publishing. */
export const closeDateOf = (args: {
  defaultDays: number
  expireDays: null | string | undefined
  jobDuration: null | string | undefined
  modifiedAt: Date | null
  now: Date
  publishedAt: Date
  reason: null | string | undefined
  status: 'expired' | 'published'
}): Date => {
  const days = positiveInt(args.expireDays) ?? positiveInt(args.jobDuration) ?? args.defaultDays
  const planned = new Date(args.publishedAt.getTime() + days * DAY_MS)
  if (args.status === 'published') return planned
  // An expired job that was ended or cancelled early closed when it was last modified.
  const early = /^(user_ended|user_canceled|admin_cancelled|order_failed)$/.test(String(args.reason ?? ''))
  const modified = args.modifiedAt
  if ((early || planned.getTime() > args.now.getTime()) && modified && modified > args.publishedAt && modified < planned) {
    return modified
  }
  // Never in the future for an expired job, or the 12-month 410 clock would not have started.
  if (planned.getTime() > args.now.getTime()) {
    const ended = modified && modified > args.publishedAt ? modified : args.now
    return ended < planned ? ended : planned
  }
  return planned
}

export type Placement = { expiresAt: string; placement: 'featured-in-category' | 'featured-in-listings'; startsAt: string }

/**
 * Featured placements from the legacy flags. A flagged job is featured from its start date (else
 * its publish date) for the paid duration, or until it closes when no duration was stored.
 * Placements that have already ended are not imported: the daily clean-up would remove them.
 */
export const placementsOf = (args: {
  closesAt: Date
  featuredInCategory: boolean
  meta: Record<string, string | undefined>
  now: Date
  offsetMinutes: number
  publishedAt: Date
}): { ended: number; placements: Placement[]; skippedCategory: number } => {
  const out = { ended: 0, placements: [] as Placement[], skippedCategory: 0 }
  for (const [key, placement] of [
    ['_jr_featured-listings', 'featured-in-listings'],
    ['_jr_featured-cat', 'featured-in-category'],
  ] as const) {
    if (!isOn(args.meta[key])) continue
    if (placement === 'featured-in-category' && !args.featuredInCategory) {
      out.skippedCategory++
      continue
    }
    const start = parseLegacyDate(args.meta[`${key}_start_date`], args.offsetMinutes) ?? args.publishedAt
    const days = positiveInt(args.meta[`${key}_duration`])
    const end = days ? new Date(start.getTime() + days * DAY_MS) : args.closesAt
    if (end.getTime() <= args.now.getTime() || end <= start) {
      out.ended++
      continue
    }
    out.placements.push({ expiresAt: end.toISOString(), placement, startsAt: start.toISOString() })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Reading the legacy jobs
// ---------------------------------------------------------------------------------------------

const META_KEYS = [
  '_Company',
  '_CompanyURL',
  '_how_to_apply',
  '_jr_job_duration',
  '_jr_fx_expire_days',
  'jr_fx_apps_recipient_address',
  'jr_fx_disable_apply_online',
  '_displayed_salary',
  '_jr_featured-listings',
  '_jr_featured-listings_start_date',
  '_jr_featured-listings_duration',
  '_jr_featured-cat',
  '_jr_featured-cat_start_date',
  '_jr_featured-cat_duration',
  '_jr_expired_reason',
  'jr_total_count',
  '_jr_address',
  'geo_short_address',
  '_jr_geo_short_address',
  'geo_address',
  '_jr_geo_address',
  '_jr_geo_town',
  '_jr_geo_region',
] as const

export type LegacyJob = {
  authorId: number
  /** `post_content`: the HTML description. */
  content: string
  /** Normalised `_Company`, or `''`. */
  companyKey: string
  id: number
  meta: Record<string, string | undefined>
  modified: null | string
  modifiedGmt: null | string
  name: string
  postDate: null | string
  postDateGmt: null | string
  status: string
  terms: { collection: 'job-categories' | 'job-types' | 'salary-bands'; term: LegacyTerm }[]
  title: string
  views: number
}

export type CompanyGroup = { legacyId: number; name: string; slug: string }

export type JobsPlan = {
  /** `_Company` groups with no organisation from the users import. */
  companies: CompanyGroup[]
  /** Normalised company name → the legacy id of its organisation. */
  companyOrganisation: Map<string, number>
  jobs: LegacyJob[]
  termsByCollection: Record<'job-categories' | 'job-types' | 'salary-bands', LegacyTerm[]>
  /** Every slug the jobs would use before collision handling, for uniqueness. */
  baseSlugs: Map<number, string>
  baseSlugSet: Set<string>
  /** Legacy author id → the legacy id of their organisation (the users import). */
  authorOrganisation: Map<number, number>
}

const chunk = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export const buildJobsPlan = async (reader: MysqlReader, users: ImportPlan): Promise<JobsPlan> => {
  const termsByCollection = {
    'job-categories': await readTaxonomyTerms(reader, LEGACY_TAXONOMY_KEYS['job-categories']),
    'job-types': await readTaxonomyTerms(reader, LEGACY_TAXONOMY_KEYS['job-types']),
    'salary-bands': await readTaxonomyTerms(reader, LEGACY_TAXONOMY_KEYS['salary-bands']),
  }
  const termOf = new Map<number, { collection: keyof typeof termsByCollection; term: LegacyTerm }>()
  for (const [collection, terms] of Object.entries(termsByCollection) as [keyof typeof termsByCollection, LegacyTerm[]][]) {
    for (const term of terms) termOf.set(term.term_taxonomy_id, { collection, term })
  }

  const posts: Record<string, unknown>[] = []
  for await (const row of reader.rows<Record<string, unknown>>('posts', { params: ['job_listing'], where: 'post_type = ?' })) {
    posts.push(row)
  }
  const wanted = new Set(posts.map((post) => Number(post.ID)))

  const metaOf = new Map<number, Record<string, string>>()
  for await (const row of reader.rows<Record<string, unknown>>('postmeta', {
    key: 'meta_id',
    params: [...META_KEYS],
    where: `meta_key IN (${META_KEYS.map(() => '?').join(', ')})`,
  })) {
    const id = Number(row.post_id)
    if (!wanted.has(id)) continue
    const meta = metaOf.get(id) ?? {}
    meta[String(row.meta_key)] = String(row.meta_value ?? '') // the last duplicate wins, as `get_post_meta(..., true)` does
    metaOf.set(id, meta)
  }

  // The visit counter is its own table on JobRoller (`wp_jr_counter_total`); the post meta
  // `jr_total_count` is the fallback for a site that has no such table.
  const counter = new Map<number, number>()
  try {
    for await (const row of reader.rows<Record<string, unknown>>('jr_counter_total', { key: 'postnum' })) {
      counter.set(Number(row.postnum ?? row.post_id), Number(row.postcount ?? row.count ?? 0))
    }
  } catch {
    // no counter table: the meta is used
  }

  const relations = new Map<number, number[]>()
  for (const ids of chunk([...wanted], 400)) {
    const rows = await reader.query<Record<string, unknown>>(
      `SELECT * FROM \`${reader.table('term_relationships')}\` WHERE object_id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    )
    for (const row of rows) {
      const id = Number(row.object_id)
      relations.set(id, [...(relations.get(id) ?? []), Number(row.term_taxonomy_id)])
    }
  }

  const jobs: LegacyJob[] = []
  for (const post of posts) {
    const id = Number(post.ID)
    const meta = metaOf.get(id) ?? {}
    const terms = [...new Set(relations.get(id) ?? [])]
      .sort((a, b) => a - b)
      .flatMap((ttid) => termOf.get(ttid) ?? [])
    const views = counter.get(id) ?? Number.parseInt(meta.jr_total_count ?? '0', 10)
    jobs.push({
      authorId: Number(post.post_author),
      content: String(post.post_content ?? ''),
      companyKey: normaliseOrganisationName(meta._Company),
      id,
      meta,
      modified: post.post_modified ? String(post.post_modified) : null,
      modifiedGmt: post.post_modified_gmt ? String(post.post_modified_gmt) : null,
      name: String(post.post_name ?? ''),
      postDate: post.post_date ? String(post.post_date) : null,
      postDateGmt: post.post_date_gmt ? String(post.post_date_gmt) : null,
      status: String(post.post_status ?? ''),
      terms,
      title: legacyText(post.post_title as string),
      views: Number.isFinite(views) && views > 0 ? views : 0,
    })
  }
  jobs.sort((a, b) => a.id - b.id)

  // `_Company` names that the users import has no organisation for become organisations of their own.
  const groupByName = new Map(users.groups.map((g) => [normaliseOrganisationName(g.name), g.members[0]!.user.ID]))
  const companyOrganisation = new Map(groupByName)
  const usedSlugs = new Set(users.groups.map((g) => g.slug))
  const companies: CompanyGroup[] = []
  for (const job of jobs) {
    if (!importableStatus(job.status) || !job.companyKey || companyOrganisation.has(job.companyKey)) continue
    // The lowest job id of a name is stable across runs; negative so it never meets a user id.
    const legacyId = -job.id
    const name = legacyText(job.meta._Company)
    const base = legacySlug(name) ?? `organisation-${job.id}`
    const slug = usedSlugs.has(base) ? `${base}-${job.id}` : base
    usedSlugs.add(slug)
    companyOrganisation.set(job.companyKey, legacyId)
    companies.push({ legacyId, name, slug })
  }

  const baseSlugs = new Map(
    jobs.map((job) => [job.id, legacySlugPart(job.name) || legacySlugPart(job.title) || `job-${job.id}`] as const),
  )
  const authorOrganisation = new Map([...users.organisationOf].map(([id, o]) => [id, o.organisationLegacyId] as const))
  return { authorOrganisation, baseSlugSet: new Set(baseSlugs.values()), baseSlugs, companies, companyOrganisation, jobs, termsByCollection }
}

// ---------------------------------------------------------------------------------------------
// Tenant lookups (one read per run)
// ---------------------------------------------------------------------------------------------

type Lookups = {
  categories: Map<number, number | string>
  jobTypes: Map<number, number | string>
  locations: LocationDoc[]
  matcher: JobLocationMatcher
  organisations: Map<number, number | string>
  salaryBands: Map<number, number | string>
  /** Slugs of categories, locations and job types: a job slug may not equal one (decision 19 Nov). */
  taxonomySlugs: Set<string>
}

const idsByLegacyId = async (ctx: ImportContext, collection: string): Promise<{ docs: Record<string, any>[]; map: Map<number, number | string> }> => {
  const { docs } = await ctx.payload.find({
    collection,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { tenant: { equals: ctx.tenant } },
  })
  const map = new Map<number, number | string>()
  for (const doc of docs) if (typeof doc.legacyId === 'number') map.set(doc.legacyId, doc.id)
  return { docs, map }
}

// ---------------------------------------------------------------------------------------------
// Importers
// ---------------------------------------------------------------------------------------------

export const jobsImporters = (
  options: JobsImportOptions,
): { jobOrganisations: Importer<CompanyGroup>; jobs: Importer<LegacyJob> } => {
  const slugs = { ...DEFAULT_SLUGS, ...options.slugs }
  const reserved = new Set(options.reservedSlugs ?? DEFAULT_RESERVED)
  const offset = options.siteUtcOffsetMinutes ?? 0
  const defaultDays = options.defaultDurationDays ?? 30
  const clock = options.now ?? (() => new Date())

  let cached: { plan: Promise<JobsPlan>; reader: MysqlReader } | undefined
  let plan: JobsPlan | undefined
  const planFor = (reader: MysqlReader): Promise<JobsPlan> => {
    if (!cached || cached.reader !== reader) {
      cached = {
        plan: Promise.resolve(void Object.keys(tally).forEach((k) => delete tally[k]))
          .then(() => options.planProvider(reader)).then((users) => buildJobsPlan(reader, users)).then((p) => (plan = p)),
        reader,
      }
    }
    return cached.plan
  }

  // Per run state: reset when the plan is rebuilt for a new reader.
  let lookups: { key: string; value: Promise<Lookups> } | undefined
  let assigned = new Map<number, string>()
  let takenSlugs = new Map<string, number>()
  const tally: Record<string, number> = {}
  const count = (key: string, n = 1) => void (tally[key] = (tally[key] ?? 0) + n)

  const lookupsFor = (ctx: ImportContext): Promise<Lookups> => {
    const key = String(ctx.tenant)
    if (lookups?.key !== key) {
      lookups = {
        key,
        value: (async () => {
          const [categories, jobTypes, salaryBands, locations, organisations] = await Promise.all([
            idsByLegacyId(ctx, slugs.jobCategories),
            idsByLegacyId(ctx, slugs.jobTypes),
            idsByLegacyId(ctx, slugs.salaryBands),
            ctx.payload.find({ collection: slugs.locations, depth: 1, overrideAccess: true, pagination: false, where: { tenant: { equals: ctx.tenant } } }),
            idsByLegacyId(ctx, slugs.organisations),
          ])
          const locationDocs = locations.docs as unknown as LocationDoc[]
          const taxonomySlugs = new Set<string>()
          for (const doc of [...categories.docs, ...jobTypes.docs, ...locationDocs]) {
            if (typeof (doc as any).slug === 'string') taxonomySlugs.add((doc as any).slug)
          }
          // Terms about to be imported count too, so a dry run on an empty tenant sees the same clashes.
          if (plan) {
            for (const collection of ['job-categories', 'job-types'] as const) {
              for (const term of importableTerms(plan.termsByCollection[collection])) {
                const slug = legacySlug(term.slug, term.name)
                if (slug) taxonomySlugs.add(slug)
              }
            }
          }
          return {
            categories: categories.map,
            jobTypes: jobTypes.map,
            locations: locationDocs,
            matcher: buildJobLocationMatcher(locationDocs, options.location),
            organisations: organisations.map,
            salaryBands: salaryBands.map,
            taxonomySlugs,
          }
        })(),
      }
      assigned = new Map()
      takenSlugs = new Map()
    }
    return lookups.value
  }

  const jobOrganisations: Importer<CompanyGroup> = {
    collection: slugs.organisations,
    dependsOn: ['organisations'],
    map: (company): MappedDoc => ({
      // Everything a site manager may edit after the import is written once.
      createOnly: {
        approved: true, // an organisation with a past published or expired job is approved (decision 19 Nov)
        canPayByInvoice: false,
        listingRequested: false,
        name: company.name,
        pageEnabled: false, // new organisations are private
        slug: company.slug,
      },
      data: {},
      legacyId: company.legacyId,
    }),
    name: 'job-organisations',
    read: async function* (reader) {
      yield* (await planFor(reader)).companies
    },
    report: () => ({ 'organisations created from a job company name': plan?.companies.length ?? 0 }),
  }

  const jobs: Importer<LegacyJob> = {
    collection: slugs.jobs,
    dependsOn: ['job-organisations', 'job-categories', 'job-types', 'salary-bands'],
    map: async (job, ctx): Promise<MappedDoc | SkippedRow> => {
      const status = importableStatus(job.status)
      if (!status) {
        // Left the site (draft, trash, ...): a sync may expire the job an earlier run imported.
        return { legacyId: job.id, skip: `status-${job.status || 'none'}` }
      }
      // A data problem, not a removal: an earlier import of the job stays.
      if (!job.title) return { keep: true, legacyId: job.id, skip: 'no-title' }
      const publishedAt = parseLegacyDate(job.postDateGmt) ?? parseLegacyDate(job.postDate, offset)
      if (!publishedAt) return { keep: true, legacyId: job.id, skip: 'no-date' }

      const look = await lookupsFor(ctx)
      const current = plan!

      // Organisation: the `_Company` match, else the author's own organisation.
      const authorOrg = current.authorOrganisation.get(job.authorId)
      const organisationLegacyId =
        (job.companyKey ? current.companyOrganisation.get(job.companyKey) : undefined) ?? authorOrg
      if (organisationLegacyId === undefined) return { keep: true, legacyId: job.id, skip: 'no-organisation' }
      const organisation = look.organisations.get(organisationLegacyId)
      if (organisation === undefined && !ctx.dryRun) {
        throw new Error(`Organisation ${organisationLegacyId} was not found: run the organisations first`)
      }

      count(`imported ${status}`)

      // Slug: kept for URL parity, unless it equals a taxonomy slug or a reserved word.
      const base = current.baseSlugs.get(job.id)!
      let slug = assigned.get(job.id)
      if (!slug) {
        slug = base
        for (let n = 2; look.taxonomySlugs.has(slug) || reserved.has(slug) || (takenSlugs.has(slug) && takenSlugs.get(slug) !== job.id) || (slug !== base && current.baseSlugSet.has(slug)); n++) {
          slug = `${base}-${n}`
        }
        assigned.set(job.id, slug)
        takenSlugs.set(slug, job.id)
        if (slug !== base) count('slugs suffixed (clash with a category, location, type or reserved word)')
      }

      // Taxonomies, cleaned up.
      const pick = (collection: 'job-categories' | 'job-types' | 'salary-bands') => {
        const all = current.termsByCollection[collection]
        const out: LegacyTerm[] = []
        for (const entry of job.terms.filter((t) => t.collection === collection)) {
          const term = canonicalTerm(collection, entry.term, all)
          if (!term) {
            count(`dropped ${collection} term: ${legacyText(entry.term.name)}`)
            continue
          }
          if (!out.some((t) => t.term_id === term.term_id)) out.push(term)
        }
        return out
      }
      const idOf = (map: Map<number, number | string>, term: LegacyTerm) => map.get(term.term_id)
      const preferred = (terms: LegacyTerm[]) => terms.find((t) => legacySlugPart(t.slug) !== 'not-stated') ?? terms[0]
      const jobType = preferred(pick('job-types'))
      const salary = preferred(pick('salary-bands'))
      const categories = pick('job-categories')
      if (jobType) count(`job type: ${legacyText(jobType.name)}`)
      else count('job type: none')
      if (salary) count(`salary band: ${legacyText(salary.name)}`)
      else count('salary band: none')
      for (const category of categories) count(`category: ${legacyText(category.name)}`)
      const link = (map: Map<number, number | string>, term: LegacyTerm | undefined) => (term ? idOf(map, term) : undefined)
      if (!ctx.dryRun) {
        const missing = categories.find((term) => !look.categories.has(term.term_id))
        if (missing) throw new Error(`The category "${legacyText(missing.name)}" was not found: run the taxonomies first`)
        for (const [label, term, map] of [['job type', jobType, look.jobTypes], ['salary band', salary, look.salaryBands]] as const) {
          if (term && !map.has(term.term_id)) throw new Error(`The ${label} "${legacyText(term.name)}" was not found: run the taxonomies first`)
        }
      }

      // Locations.
      const address = jobAddressLabel(job.meta)
      const match = address ? look.matcher(address) : { exact: false, locations: [], unmatched: [] as string[] }
      if (!address) count('location: none')
      else if (match.locations.length === 0) count('location: unmatched (kept as details)')
      else count(match.exact ? 'location: matched exactly' : 'location: matched, original kept as details')

      // Dates, close date, featured, views.
      const modifiedAt = parseLegacyDate(job.modifiedGmt) ?? parseLegacyDate(job.modified, offset)
      const closesAt = closeDateOf({
        defaultDays,
        expireDays: job.meta._jr_fx_expire_days,
        jobDuration: job.meta._jr_job_duration,
        modifiedAt,
        now: clock(),
        publishedAt,
        reason: job.meta._jr_expired_reason,
        status,
      })
      const featured = placementsOf({
        closesAt,
        featuredInCategory: options.featuredInCategory ?? false,
        meta: job.meta,
        now: clock(),
        offsetMinutes: offset,
        publishedAt,
      })
      count('featured placements imported', featured.placements.length)
      count('featured placements already ended (not imported)', featured.ended)
      count('featured-in-category flags not seeded', featured.skippedCategory)

      // The counter never goes backwards on a re-run.
      let views = job.views
      const existing = await ctx.payload.find({
        collection: slugs.jobs,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { and: [{ legacyId: { equals: job.id } }, { tenant: { equals: ctx.tenant } }] },
      })
      const previous = Number(existing.docs[0]?.views ?? 0)
      if (previous > views) views = previous
      count('views imported', views)

      const company = legacyText(job.meta._Company)
      const data: Record<string, unknown> = {
        applyOnline: !isOn(job.meta.jr_fx_disable_apply_online),
        categories: categories.flatMap((term) => idOf(look.categories, term) ?? []),
        expiresAt: closesAt.toISOString(),
        location: match.locations.map((doc) => doc.id),
        placements: featured.placements,
        publishedAt: publishedAt.toISOString(),
        slug,
        status,
        title: job.title,
        views,
      }
      const set = (key: string, value: unknown) => {
        if (value !== undefined && value !== null && value !== '') data[key] = value
      }
      set('organisation', organisation)
      set('jobType', link(look.jobTypes, jobType))
      set('salaryBand', link(look.salaryBands, salary))
      set('displayedSalary', legacyText(job.meta._displayed_salary))
      set('description', htmlToLexical(job.content) ?? undefined)
      set('howToApply', htmlToPlainText(job.meta._how_to_apply))
      set('applicationsRecipient', cleanEmail(job.meta.jr_fx_apps_recipient_address))
      set('companyUrl', cleanUrl(job.meta._CompanyURL))
      // The job's own company name, set explicitly: `rawCreate` skips the hook that defaults it.
      set('companyName', company)
      set('locationDetails', address && !match.exact ? address : undefined)

      return {
        // Created through the adapter, so the array rows need the id Payload's hooks would give them.
        createOnly: { placements: featured.placements.map((row) => ({ ...row, id: randomUUID() })) },
        data,
        legacyId: job.id,
        // A job can't be created as expired through the hooks (the state machine), so it is
        // created through the adapter, with every field given. Re-runs update normally.
        rawCreate: true,
        // The guard on `views` lets only the view counter change it.
        updateContext: { jobViews: true },
      }
    },
    name: 'jobs',
    // Sync: a live job that left the legacy site (trashed, unpublished) is expired here, never
    // deleted. Expired can be relisted when the job comes back; cancelled is final, so it would
    // fail every later sync of that job. A job that is not live has nothing to take off the site.
    removal: (doc) => (doc.status === 'published' ? { status: 'expired' } : undefined),
    read: async function* (reader) {
      yield* (await planFor(reader)).jobs
    },
    report: () => ({ ...tally, 'legacy jobs read': plan?.jobs.length ?? 0 }),
  }

  return { jobOrganisations, jobs }
}
