import { describe, expect, it } from 'vitest'

import { createMemoryContentVersionStore } from '@mission-control/content-cache'

import { contentVersionStore } from './store'

describe('contentVersionStore @S-240', () => {
  it('returns the KV namespace bound as CONTENT_CACHE', () => {
    const kv = createMemoryContentVersionStore({ vwok: 'v1' })

    expect(contentVersionStore({ CONTENT_CACHE: kv })).toBe(kv)
  })

  it('answers undefined on a deployment with no namespace, so pages fall back to version 0', () => {
    expect(contentVersionStore({})).toBeUndefined()
    expect(contentVersionStore(undefined)).toBeUndefined()
    expect(contentVersionStore(null)).toBeUndefined()
  })

  it('ignores a binding that is not a KV namespace, rather than failing a page', () => {
    expect(contentVersionStore({ CONTENT_CACHE: 'not-a-namespace' })).toBeUndefined()
    expect(contentVersionStore({ CONTENT_CACHE: { get: () => null } })).toBeUndefined()
  })
})
