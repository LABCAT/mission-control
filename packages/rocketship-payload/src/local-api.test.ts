import type { Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { findDocumentBlocks, findGlobalBlocks } from './local-api'

const payloadWith = (overrides: Record<string, unknown>) =>
  ({
    find: vi.fn(),
    findGlobal: vi.fn(),
    ...overrides,
  }) as unknown as Payload

describe('local API blocks', () => {
  it('loads a document by slug and reads its layout blocks', async () => {
    const find = vi.fn().mockResolvedValue({
      docs: [{ id: 1, layout: [{ blockType: 'hero', heading: 'Welcome' }], slug: 'about' }],
    })
    const payload = payloadWith({ find })

    const result = await findDocumentBlocks(payload, { collection: 'pages', slug: 'about' })

    expect(find).toHaveBeenCalledWith({
      collection: 'pages',
      depth: 1,
      limit: 1,
      where: { slug: { equals: 'about' } },
    })
    expect(result.document).toMatchObject({ id: 1, slug: 'about' })
    expect(result.blocks).toEqual([{ blockType: 'hero', heading: 'Welcome' }])
  })

  it('returns no blocks when the document does not exist', async () => {
    const payload = payloadWith({ find: vi.fn().mockResolvedValue({ docs: [] }) })

    await expect(
      findDocumentBlocks(payload, { collection: 'pages', slug: 'missing' }),
    ).resolves.toEqual({ blocks: [], document: null })
  })

  it('reads a field other than layout from a global', async () => {
    const findGlobal = vi.fn().mockResolvedValue({
      headerBanner: [{ blockType: 'banner', desktopImage: { url: '/banner.jpg' } }],
    })
    const payload = payloadWith({ findGlobal })

    const result = await findGlobalBlocks(payload, {
      field: 'headerBanner',
      slug: 'site-settings',
    })

    expect(findGlobal).toHaveBeenCalledWith({ depth: 1, slug: 'site-settings' })
    expect(result.blocks).toEqual([
      { blockType: 'banner', desktopImage: { url: '/banner.jpg' } },
    ])
  })

  it('returns no blocks when the field is not an array', async () => {
    const payload = payloadWith({
      findGlobal: vi.fn().mockResolvedValue({ layout: 'not blocks' }),
    })

    await expect(findGlobalBlocks(payload, { slug: 'site-settings' })).resolves.toMatchObject({
      blocks: [],
    })
  })
})
