export type MediaImage = {
  alt?: null | string
  height?: null | number
  url?: null | string
  width?: null | number
}

export type Salary = {
  /** Integer minor units in `currency`. */
  amountMinor: number
  currency: string
  /** ISO 4217 exponent, from the job's tenant. */
  minorUnits?: null | number
  /** `year`, `month`, `hour` … shown after the amount. */
  period?: null | string
}

export type JobSummary = {
  /** Stable job identifier, used by the browser-only viewed-jobs history. Defaults to `url`. */
  id?: null | number | string
  title: string
  /** Path on the current site, e.g. `/jobs/123`. */
  url: string
  organisation: {
    name: string
    url?: null | string
    logo?: null | MediaImage
  }
  /** Human-readable place, e.g. `Port Vila, Vanuatu`. */
  location?: null | string
  /** `Full time`, `Voluntary` … already labelled for the tenant. */
  jobType?: null | string
  salary?: null | Salary
  /** Free text an employer typed, e.g. `Vt 1,500 a day`. Shown when there is no structured salary. */
  displayedSalary?: null | string
  /** ISO date (`2026-12-01`, a calendar day) or instant, rendered in the tenant timezone. */
  closes?: null | string
  summary?: null | string
  featured?: boolean
  isVolunteer?: boolean
}

export type OrgSummary = {
  name: string
  url: string
  logo?: null | MediaImage
  description?: null | string
  location?: null | string
  /** Open jobs for this organisation. */
  jobCount?: null | number
}
