/**
 * What a share (Open Graph) image shows (PJ-105), as data. `layout.ts` draws it and `render.ts`
 * rasterises it; this module is pure, so a card can be built and asserted without the WASM.
 *
 * Everything tenant-specific comes from the tenant: its name, its colours, its logo. Nothing
 * here hard-codes a site.
 */
import type { JobDetailView } from '../jobs/detail'
import type { OrganisationProfile } from '../organisations/profile'
import { normaliseHex, readableOn } from '../tenant/branding'
import type { SiteTenant } from '../tenant/types'
import type { MediaImage } from '../types'

/** Page kinds that get a generated image. */
export type OgKind = 'home' | 'job' | 'organisation'

export type OgCard = {
  /** Tenant primary colour, normalised to `#rrggbb`. */
  accent: string
  /** Black or white, whichever reads on `accent`. */
  accentText: string
  /** Short line above the title: the tenant's name. */
  eyebrow: string
  /** Pills under the title: location, job type, size. Skipped when empty. */
  facts: string[]
  kind: OgKind
  /** Absolute logo URL, when the page has one; the site logo is the fallback. */
  logo?: { url: string }
  /** The site's own name, in the footer. */
  siteName: string
  /** The line under the title: the organisation, or the page's description. */
  subtitle?: string
  title: string
}

/** Share images are `og:image` sized: 1200x630, as social scrapers expect. */
export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

const DEFAULT_ACCENT = '#1f2937'
/** A title gets two lines at the card's size; 70 characters fills them. */
const TITLE_LIMIT = 70
const SUBTITLE_LIMIT = 90
const FACT_LIMIT = 32

/**
 * Cut `text` to `limit` characters, on a word boundary when one is near the end, and mark the
 * cut with an ellipsis. Long text must not overflow the card, so this clamps rather than measures.
 */
export const clamp = (text: string, limit: number): string => {
  const value = text.replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value

  const cut = value.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  const trimmed = space > limit * 0.6 ? cut.slice(0, space) : cut

  return `${trimmed.replace(/[\s,;:.-]+$/, '')}…`
}

const text = (value: null | string | undefined): string | undefined => value?.trim() || undefined

/**
 * Absolute logo URL. A CMS media URL is absolute; a site asset (`/brand/logo.png`) is a path,
 * so it is resolved against the deployment's origin. With no origin there is nothing to resolve
 * a path against, and a made-up host would only fail later at the fetch.
 */
const logoOf = (logo: MediaImage | null | undefined, origin?: string): { url: string } | undefined => {
  const url = text(logo?.url)
  if (!url) return undefined

  try {
    const resolved = new URL(url, origin)

    return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? { url: resolved.toString() } : undefined
  } catch {
    return undefined
  }
}

const factsOf = (...values: (null | string | undefined)[]): string[] =>
  values
    .map(text)
    .filter((value): value is string => Boolean(value))
    .map((value) => clamp(value, FACT_LIMIT))
    .slice(0, 3)

/** The tenant's palette, with the text colour that reads on it. */
const palette = (tenant: SiteTenant): Pick<OgCard, 'accent' | 'accentText'> => {
  const accent = normaliseHex(tenant.branding?.colorPrimary) ?? DEFAULT_ACCENT

  return { accent, accentText: readableOn(accent) }
}

export type JobCardInput = {
  /** The job page's data; the job's own tenant is already merged into `view.tenant`. */
  view: Pick<JobDetailView, 'detail' | 'tenant'>
  /** The deployment's origin, so a site logo given as a path is absolute. */
  origin?: string
}

/** A job's share image: its title, who is hiring, and where and how it is offered. */
export const jobCard = ({ origin, view }: JobCardInput): OgCard => {
  const { detail, tenant } = view
  const logo = logoOf(detail.organisation.logo, origin) ?? logoOf(tenant.branding?.logo, origin)

  return {
    ...palette(tenant),
    eyebrow: clamp(tenant.name, 40),
    facts: factsOf(detail.location, detail.jobType, detail.displayedSalary),
    kind: 'job',
    ...(logo ? { logo } : {}),
    siteName: tenant.name,
    subtitle: clamp(detail.organisation.name, SUBTITLE_LIMIT),
    title: clamp(detail.title, TITLE_LIMIT),
  }
}

export type OrganisationCardInput = {
  origin?: string
  profile: Pick<OrganisationProfile, 'location' | 'logo' | 'name' | 'sizeLabel' | 'typeLabel'>
  tenant: SiteTenant
}

/** An organisation's share image: its name, what it is, and where. */
export const organisationCard = ({ origin, profile, tenant }: OrganisationCardInput): OgCard => {
  const logo = logoOf(profile.logo, origin) ?? logoOf(tenant.branding?.logo, origin)

  return {
    ...palette(tenant),
    eyebrow: clamp(tenant.name, 40),
    facts: factsOf(profile.typeLabel, profile.sizeLabel, profile.location),
    kind: 'organisation',
    ...(logo ? { logo } : {}),
    siteName: tenant.name,
    title: clamp(profile.name, TITLE_LIMIT),
  }
}

export type HomeCardInput = {
  /** The home page's own description, when the CMS has one. */
  description?: null | string
  /** The deployment's origin, so a site logo given as a path is absolute. */
  origin?: string
  tenant: SiteTenant
  /** The home page's title from the CMS; the tenant's name when it has none. */
  title?: null | string
}

/** The home page's share image: who the site is, in the tenant's own words. */
export const homeCard = ({ description, origin, tenant, title }: HomeCardInput): OgCard => {
  const logo = logoOf(tenant.branding?.logo, origin)
  const subtitle = text(description)

  return {
    ...palette(tenant),
    eyebrow: clamp(tenant.name, 40),
    facts: [],
    kind: 'home',
    ...(logo ? { logo } : {}),
    siteName: tenant.name,
    ...(subtitle ? { subtitle: clamp(subtitle, SUBTITLE_LIMIT) } : {}),
    title: clamp(text(title) ?? tenant.name, TITLE_LIMIT),
  }
}
