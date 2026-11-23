import { describe, expect, it } from 'vitest'

import type { CmsClient } from '../cms/client'
import { liveJobsWhere } from '../jobs/listing'
import {
  LATEST_JOBS_LIMIT,
  LATEST_JOBS_MAX_LIMIT,
  latestJobsLimit,
  loadLatestJobs,
} from './latest-jobs'

const tenant = { currency: 'VUV', name: 'Vanuatu Wok', slug: 'vwok', timezone: 'Pacific/Efate' }
const NOW = new Date('2026-11-20T00:00:00.000Z')

const job = (id: number, input: { featuredUntil?: string; title?: string } = {}) => ({
  id,
  organisation: { id: 1, name: 'YCV', slug: 'ycv' },
  placements: input.featuredUntil
    ? [{ expiresAt: input.featuredUntil, placement: 'featured-in-listings', startsAt: '2026-11-01T00:00:00.000Z' }]
    : [],
  publishedAt: '2026-11-01T00:00:00.000Z',
  slug: `job-${id}`,
  title: input.title ?? `Job ${id}`,
})

const cmsReturning = (docs: unknown[], totalDocs = docs.length) => {
  const calls: { collection: string; options: Record<string, unknown> }[] = []
  const cms = {
    find: async (collection: string, options: Record<string, unknown>) => {
      calls.push({ collection, options })
      return { docs, totalDocs } as never
    },
  } as unknown as Pick<CmsClient, 'find'>

  return { calls, cms }
}

describe('latest jobs block', () => {
  it('asks for live jobs only, newest first, and shows featured jobs first @S-294', async () => {
    const { calls, cms } = cmsReturning([
      job(1),
      job(2, { featuredUntil: '2026-12-01T00:00:00.000Z' }),
      job(3),
      // An ended placement is not featured any more.
      job(4, { featuredUntil: '2026-11-10T00:00:00.000Z' }),
    ])

    const result = await loadLatestJobs({ cms, now: NOW, tenant })

    expect(result.jobs.map((entry) => entry.title)).toEqual(['Job 2', 'Job 1', 'Job 3', 'Job 4'])
    expect(result.jobs[0]?.featured).toBe(true)
    expect(result.jobs[1]?.featured).toBeUndefined()
    expect(calls[0]).toMatchObject({ collection: 'jobs' })
    expect(calls[0]?.options).toMatchObject({ depth: 2, sort: ['-publishedAt', '-id'] })
    expect(calls[0]?.options.where).toEqual(liveJobsWhere(NOW))
  })

  it('clamps the block limit so a page stays bounded @S-294', () => {
    expect(latestJobsLimit(undefined)).toBe(LATEST_JOBS_LIMIT)
    expect(latestJobsLimit(0)).toBe(LATEST_JOBS_LIMIT)
    expect(latestJobsLimit(-3)).toBe(LATEST_JOBS_LIMIT)
    expect(latestJobsLimit('5')).toBe(5)
    expect(latestJobsLimit(5.9)).toBe(5)
    expect(latestJobsLimit(10_000)).toBe(LATEST_JOBS_MAX_LIMIT)
  })

  it('says when the block is a slice of a larger board @S-294', async () => {
    const { cms } = cmsReturning([job(1)], 42)

    expect(await loadLatestJobs({ cms, now: NOW, tenant })).toMatchObject({ truncated: true })
  })

  it('drops a job that cannot be drawn instead of rendering a broken card @S-294', async () => {
    const { cms } = cmsReturning([
      { id: 1, organisation: { id: 1, name: 'YCV' }, slug: 'no-title' },
      job(2),
    ])

    const result = await loadLatestJobs({ cms, now: NOW, tenant })

    expect(result.jobs).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })
})
