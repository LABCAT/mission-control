import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import AlertManageList from './AlertManageList.astro'
import AlertManageRequest from './AlertManageRequest.astro'
import AlertNotice from './AlertNotice.astro'
import AlertSignup from './AlertSignup.astro'

let container: Awaited<ReturnType<typeof AstroContainer.create>>

beforeAll(async () => {
  container = await AstroContainer.create()
})

const render = (component: Parameters<typeof container.renderToString>[0], props: Record<string, unknown>) =>
  container.renderToString(component, { props })

describe('AlertSignup @S-085 @S-363', () => {
  it('is a plain POST form that carries the listing’s filters and nothing else', async () => {
    const html = await render(AlertSignup, {
      filters: { category: 'hospitality', location: 'efate', page: '3', q: 'cook' },
      summary: '“cook” · Hospitality',
    })

    expect(html).toContain('action="/alerts/subscribe"')
    expect(html).toContain('method="post"')
    expect(html).toContain('type="hidden" name="q" value="cook"')
    expect(html).toContain('type="hidden" name="category" value="hospitality"')
    expect(html).toContain('type="hidden" name="location" value="efate"')
    // Pagination is not part of the search.
    expect(html).not.toContain('name="page"')
    expect(html).toContain('Get these jobs by email')
    expect(html).toContain('New jobs for “cook” · Hospitality')
  })

  it('asks for the address, defaults to daily, and offers weekly', async () => {
    const html = await render(AlertSignup, {})

    expect(html).toMatch(/<input[^>]*name="email"[^>]*required|<input[^>]*required[^>]*name="email"/)
    expect(html).toMatch(/<option value="daily" selected/)
    expect(html).toContain('<option value="weekly"')
    expect(html).toContain('name="alert_website"')
  })

  it('shows the consent line, and ships no script unless Turnstile is on', async () => {
    const without = await render(AlertSignup, {})
    expect(without).toContain('By subscribing you agree')
    expect(without).toContain('href="/privacy"')
    expect(without).not.toContain('<script')
    expect(without).not.toContain('cf-turnstile-response')

    const withWidget = await render(AlertSignup, { turnstileSiteKey: '0x4AAAAAAAAAAAAAAAAAAAAAA' })
    expect(withWidget).toContain('cf-turnstile-response')
  })

  it('escapes what the visitor typed into the filters', async () => {
    const html = await render(AlertSignup, { filters: { q: '"><script>alert(1)</script>' } })

    // Inside a quoted attribute the quote is what matters: it is escaped, so the value cannot
    // close the attribute and start a tag.
    expect(html).not.toContain('value=""><script>')
    expect(html).toContain('value="&quot;><script>alert(1)</script>"')
  })
})

describe('alert manage pages @S-086 @S-087 @S-363', () => {
  const alerts = [
    { active: true, confirmed: true, frequency: 'daily', id: 4, summary: '“cook”' },
    { active: false, confirmed: false, frequency: 'weekly', id: 9, summary: 'All jobs' },
  ]

  it('draws one form per alert, so each saves, pauses and deletes alone', async () => {
    const html = await render(AlertManageList, { action: '/alerts/manage/tok', alerts })

    expect(html.match(/<form /g)).toHaveLength(2)
    expect(html).toContain('action="/alerts/manage/tok"')
    expect(html).toContain('name="id" value="4"')
    expect(html).toContain('name="id" value="9"')
    expect(html).toContain('value="delete"')
    expect(html).toContain('waiting for confirmation')
    // The paused alert's box is not ticked; the active one's is.
    expect(html).toMatch(/id="alert-4-active"[^>]*checked/)
    expect(html).not.toMatch(/id="alert-9-active"[^>]*checked/)
    expect(html).not.toContain('@')
  })

  it('says so when there are no alerts', async () => {
    expect(await render(AlertManageList, { action: '/a', alerts: [] })).toContain('You have no job alerts')
  })

  it('asks for an address to send a manage link to, with a bot trap', async () => {
    const html = await render(AlertManageRequest, {})

    expect(html).toContain('action="/alerts/manage"')
    expect(html).toContain('name="alert_website"')
    expect(html).toContain('Email me the link')
  })

  it('announces an error to assistive tech, and a success politely', async () => {
    const error = await render(AlertNotice, { notice: { kind: 'error', message: 'Bad link', title: 'Oops' } })
    const success = await render(AlertNotice, { notice: { kind: 'success', message: 'Done', title: 'Yes' } })

    expect(error).toContain('role="alert"')
    expect(success).toContain('role="status"')
  })
})

describe('the listing page offers the alert form only when asked @S-363', () => {
  it('draws the form on a listing page that passes `alerts`, with the page’s own filters', async () => {
    const { default: JobsListing } = await import('./JobsListing.astro')
    const { jobFilterDefinitions, jobListingView } = await import('../jobs/listing')
    const facets = {
      categories: [{ id: 1, name: 'Hospitality', slug: 'hospitality' }],
      locations: [],
      types: [],
    }
    const view = jobListingView({
      basePath: '/jobs',
      definitions: jobFilterDefinitions(facets),
      facets,
      filters: { category: 'hospitality', q: 'cook' },
      jobs: [],
      page: 1,
      total: 0,
    })

    const without = await container.renderToString(JobsListing, { props: { title: 'Jobs', view } })
    const withForm = await container.renderToString(JobsListing, { props: { alerts: {}, title: 'Jobs', view } })

    expect(without).not.toContain('Get these jobs by email')
    expect(withForm).toContain('Get these jobs by email')
    expect(withForm).toContain('name="q" value="cook"')
    expect(withForm).toContain('name="category" value="hospitality"')
    expect(withForm).toContain('New jobs for “cook” · Hospitality')
  })
})
