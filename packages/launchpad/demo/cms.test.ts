import { describe, expect, it } from 'vitest'

import { createDemoCms } from './src/cms'

const docs = [
  { id: 1, status: 'published', title: 'Head Chef', expiresAt: '2026-12-01' },
  { id: 2, status: 'draft', title: 'Clerk', expiresAt: '2026-12-02' },
  { id: 3, status: 'published', title: 'Chef de Partie', expiresAt: '2026-01-01' },
]

const cms = createDemoCms({ 'job-categories': [], 'job-types': [], jobs: docs, locations: [] })

describe('demo CMS', () => {
  it('applies an equality and a comparison in one query, as the live-jobs rule needs', async () => {
    const page = await cms.find('jobs', {
      where: { and: [{ status: { equals: 'published' } }, { expiresAt: { greater_than: '2026-06-01' } }] },
    })

    expect(page.docs.map((doc) => doc.id)).toEqual([1])
  })

  it('matches a keyword case-insensitively, as Payload`s `like` does', async () => {
    const page = await cms.find('jobs', { where: { title: { like: 'CHEF' } } })
    expect(page.docs.map((doc) => doc.id)).toEqual([1, 3])
  })

  it('pages the result and reports the total, so the listing can clamp a page past the end', async () => {
    const first = await cms.find('jobs', { limit: 2, page: 1 })
    const past = await cms.find('jobs', { limit: 2, page: 99 })

    expect(first.docs).toHaveLength(2)
    expect(first.totalDocs).toBe(3)
    expect(first.totalPages).toBe(2)
    expect(past.page).toBe(2)
    expect(past.docs.map((doc) => doc.id)).toEqual([3])
  })

  it('matches a relationship by id whether it is populated or not', async () => {
    const rows = [{ id: 1, jobType: { id: 20 } }, { id: 2, jobType: 21 }, { id: 3 }]
    const local = createDemoCms({ 'job-categories': [], 'job-types': [], jobs: rows, locations: [] })

    expect((await local.find('jobs', { where: { jobType: { equals: 20 } } })).docs.map((doc) => doc.id)).toEqual([1])
    expect((await local.find('jobs', { where: { jobType: { in: [21] } } })).docs.map((doc) => doc.id)).toEqual([2])
    expect((await local.find('jobs', { where: { jobType: { not_in: [20, 21] } } })).docs.map((doc) => doc.id)).toEqual([
      3,
    ])
  })

  it('compares a date-only expiry against a full timestamp by instant, not by string', async () => {
    // `2026-11-19T10:49` is after `2026-11-19`, which a text comparison gets wrong.
    const rows = [{ expiresAt: '2026-11-19', id: 1 }, { expiresAt: '2026-11-20', id: 2 }]
    const local = createDemoCms({ 'job-categories': [], 'job-types': [], jobs: rows, locations: [] })

    const live = await local.find('jobs', { where: { expiresAt: { greater_than: '2026-11-19T10:49:00.000Z' } } })
    expect(live.docs.map((doc) => doc.id)).toEqual([2])
  })

  it('refuses an operator it does not implement instead of silently matching nothing', async () => {
    await expect(cms.find('jobs', { where: { title: { near: 'chef' } } })).rejects.toThrow(/unsupported operator/)
  })
})
