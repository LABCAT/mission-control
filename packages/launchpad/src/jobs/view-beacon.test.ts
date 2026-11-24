import { describe, expect, it, vi } from 'vitest'

import { formatViewCounts, sendView } from './view-beacon'

const element = (template = '{total} views, {today} today') => {
  const target = { dataset: { viewsTemplate: template }, hidden: true, textContent: '' }
  const root = {
    dataset: { viewEndpoint: '/api/jobs/1/view' },
    querySelector: () => target,
  }

  return { root: root as unknown as HTMLElement, target }
}

describe('view beacon @S-287', () => {
  it('fills the reserved count from the answer', async () => {
    const { root, target } = element('{total} views, {today} today')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ today: 2, total: 41 })))

    await expect(sendView(root, { fetch })).resolves.toEqual({ today: 2, total: 41 })
    expect(fetch).toHaveBeenCalledWith(
      '/api/jobs/1/view',
      expect.objectContaining({ keepalive: true, method: 'POST' }),
    )
    expect(target.textContent).toBe('41 views, 2 today')
    expect(target.hidden).toBe(false)
  })

  it('uses the tenant’s own template', async () => {
    const { root, target } = element('{total} mo lukim, {today} tede')

    await sendView(root, { fetch: async () => new Response(JSON.stringify({ today: 1, total: 7 })) })

    expect(target.textContent).toBe('7 mo lukim, 1 tede')
  })

  it('leaves the count hidden when the beacon fails or answers rubbish', async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response('nope', { status: 429 })),
      vi.fn(async () => new Response('not json')),
      vi.fn(async () => new Response(JSON.stringify({ today: 1 }))),
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    ]) {
      const { root, target } = element()
      await expect(sendView(root, { fetch: fetchImpl as typeof fetch })).resolves.toBeNull()
      expect(target.hidden).toBe(true)
      expect(target.textContent).toBe('')
    }
  })

  it('does nothing without an endpoint', async () => {
    const fetch = vi.fn()
    const { root } = element()
    root.dataset.viewEndpoint = '  '

    await expect(sendView(root, { fetch: fetch as never })).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a bad count out of the text', () => {
    expect(formatViewCounts('{total} / {today}', { today: Number.NaN, total: -3 })).toBe('0 / 0')
    expect(formatViewCounts('{total} views', { today: 0, total: 12.7 })).toBe('12 views')
  })
})
