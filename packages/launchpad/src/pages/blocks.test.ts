import { describe, expect, it } from 'vitest'

import { isLatestJobsBlock, pageSegments } from './blocks'

describe('page segments', () => {
  it('keeps the editor order and groups consecutive generic blocks @S-293', () => {
    const segments = pageSegments([
      { blockType: 'hero' },
      { blockType: 'feature-boxes' },
      { blockType: 'latest-jobs' },
      { blockType: 'rich-text' },
    ])

    expect(segments.map((segment) => segment.kind)).toEqual(['blocks', 'latest-jobs', 'blocks'])
    expect(segments[0]).toMatchObject({ blocks: [{ blockType: 'hero' }, { blockType: 'feature-boxes' }] })
    expect(segments[2]).toMatchObject({ blocks: [{ blockType: 'rich-text' }] })
  })

  it('drops empty and malformed entries, which would otherwise break the renderer @S-293', () => {
    const segments = pageSegments([
      null as never,
      { blockType: 'hero' },
      {} as never,
      { blockType: 42 } as never,
      { blockType: 'cta' },
    ])

    expect(segments).toEqual([{ blocks: [{ blockType: 'hero' }, { blockType: 'cta' }], kind: 'blocks' }])
  })

  it('renders nothing for a page with no layout', () => {
    expect(pageSegments(null)).toEqual([])
    expect(pageSegments(undefined)).toEqual([])
  })

  it('recognises the latest-jobs block by its slug @S-293', () => {
    expect(isLatestJobsBlock({ blockType: 'latest-jobs' })).toBe(true)
    expect(isLatestJobsBlock({ blockType: 'hero' })).toBe(false)
    expect(isLatestJobsBlock(null)).toBe(false)
  })
})

describe('latest-jobs slug', () => {
  it('lets a site name its own block slug, and keeps the rest as generic blocks @S-293', () => {
    const segments = pageSegments(
      [{ blockType: 'hero' }, { blockType: 'recent-jobs' }, { blockType: 'cta' }],
      'recent-jobs',
    )

    expect(segments.map((segment) => segment.kind)).toEqual(['blocks', 'latest-jobs', 'blocks'])
  })

  it('leaves a block that only looks like the default alone @S-293', () => {
    const segments = pageSegments([{ blockType: 'latest-jobs' }], 'recent-jobs')

    expect(segments).toEqual([{ blocks: [{ blockType: 'latest-jobs' }], kind: 'blocks' }])
  })
})

describe('organisation directory segment (PJ-38)', () => {
  it('splits the directory out of the generic run, keeping the editor order @S-223', () => {
    const segments = pageSegments([
      { blockType: 'hero' },
      { blockType: 'organisation-directory', heading: 'Employers' },
      { blockType: 'rich-text' },
    ])

    expect(segments.map((segment) => segment.kind)).toEqual(['blocks', 'organisation-directory', 'blocks'])
  })
})
