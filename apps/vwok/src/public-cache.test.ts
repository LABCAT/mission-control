import { describe, expect, it } from 'vitest'

import { createMemoryContentVersionStore } from '@mission-control/content-cache'

import { isCacheablePath, servePublic } from './public-cache'

const request = (path: string, method = 'GET') => new Request(`https://vanuatuwok.vu${path}`, { method })
const render = async () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })

describe('which paths the public edge cache serves @S-242', () => {
  it.each([
    ['/', true],
    ['/about/team', true],
    ['/jobs', true],
    ['/account', false],
    ['/account/view-as', false],
    ['/api/me', false],
    ['/health', false],
    ['/_astro/app.abc123.css', false],
    ['/sitemap.xml', false],
    ['/robots.txt', false],
    ['/accountant', true],
  ])('%s -> %s', (path, expected) => expect(isCacheablePath(path)).toBe(expected))
})

describe('servePublic @S-241', () => {
  const env = { CONTENT_CACHE: createMemoryContentVersionStore() }

  it('leaves a POST, an account page and /health alone', () => {
    expect(servePublic({ env, next: render, request: request('/', 'POST') })).toBeNull()
    expect(servePublic({ env, next: render, request: request('/account') })).toBeNull()
    expect(servePublic({ env, next: render, request: request('/health') })).toBeNull()
  })

  it('301s a junk query to the canonical path before rendering', async () => {
    let rendered = false
    const response = await servePublic({
      env,
      next: async () => ((rendered = true), render()),
      request: request('/about?junk=1'),
    })

    expect(response?.status).toBe(301)
    expect(response?.headers.get('location')).toBe('/about')
    expect(rendered).toBe(false)
  })

  it('keeps tracking parameters: no redirect, the page renders', async () => {
    const response = await servePublic({ env, next: render, request: request('/about?utm_source=chatgpt.com') })

    expect(response?.status).toBe(200)
  })
})
