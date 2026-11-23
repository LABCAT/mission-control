import { describe, expect, it, vi } from 'vitest'

import {
  ALL_CONTENT_SCOPE,
  bumpContentVersions,
  contentVersionKey,
  createMemoryContentVersionStore,
  DEFAULT_CONTENT_VERSION,
  newContentVersion,
  readContentVersion,
  readContentVersions,
  type ContentVersionStore,
} from './index'

describe('content versions @S-240', () => {
  it('reads the default for a scope nobody has written yet', async () => {
    const store = createMemoryContentVersionStore()

    expect(DEFAULT_CONTENT_VERSION).toBe('0')
    expect(await readContentVersion(store, 'vwok')).toBe(DEFAULT_CONTENT_VERSION)
  })

  it('reads the default with no store at all, so a site without KV still renders', async () => {
    expect(await readContentVersion(undefined, 'vwok')).toBe(DEFAULT_CONTENT_VERSION)
    expect(await readContentVersions(undefined, ['vwok', ALL_CONTENT_SCOPE])).toEqual({
      [ALL_CONTENT_SCOPE]: DEFAULT_CONTENT_VERSION,
      vwok: DEFAULT_CONTENT_VERSION,
    })
  })

  it('stores one key per scope, so two tenants never share a version', async () => {
    const store = createMemoryContentVersionStore()

    await bumpContentVersions(store, ['vwok', 'hub'], { nextVersion: () => 'v1' })

    expect(store.values).toEqual(
      new Map([
        [contentVersionKey('vwok'), 'v1'],
        [contentVersionKey('hub'), 'v1'],
      ]),
    )
  })

  it('bumps each scope to a new value, so an old cache key is unreachable', async () => {
    const store = createMemoryContentVersionStore({ vwok: 'before' })

    const bumped = await bumpContentVersions(store, ['vwok'], { nextVersion: () => 'after' })

    expect(bumped).toEqual({ vwok: 'after' })
    expect(await readContentVersion(store, 'vwok')).toBe('after')
    // The old version is gone from the store, so an entry keyed by it is never served again.
    expect(await readContentVersion(store, 'vwok')).not.toBe('before')
  })

  it('gives a real bump a new version every time, so two writes never agree', async () => {
    const versions = new Set(Array.from({ length: 50 }, () => newContentVersion()))

    expect(versions.size).toBe(50)
  })

  it('drops duplicate and empty scopes, so one write is one write', async () => {
    const put = vi.fn(async () => {})
    const store: ContentVersionStore = { get: async () => null, put }

    await bumpContentVersions(store, ['vwok', 'vwok', '', ALL_CONTENT_SCOPE], { nextVersion: () => 'x' })

    expect(put.mock.calls.map(([key]) => key)).toEqual([
      contentVersionKey('vwok'),
      contentVersionKey(ALL_CONTENT_SCOPE),
    ])
  })

  it('does nothing without a store or a scope, so a Node CLI save cannot fail', async () => {
    expect(await bumpContentVersions(undefined, ['vwok'])).toEqual({})
    expect(await bumpContentVersions(createMemoryContentVersionStore(), [])).toEqual({})
  })

  it('survives a failing store: a KV outage must not fail a CMS save', async () => {
    const store: ContentVersionStore = {
      get: async () => {
        throw new Error('KV down')
      },
      put: async () => {
        throw new Error('KV down')
      },
    }

    await expect(bumpContentVersions(store, ['vwok'])).resolves.toEqual({})
    // A read falls back to the old version rather than an error page.
    await expect(readContentVersion(store, 'vwok')).resolves.toBe(DEFAULT_CONTENT_VERSION)
  })

  it('reports only the scopes whose write succeeded', async () => {
    const store: ContentVersionStore = {
      get: async () => null,
      put: async (key) => {
        if (key.endsWith('hub')) throw new Error('KV down')
      },
    }

    const bumped = await bumpContentVersions(store, ['vwok', 'hub'], { nextVersion: () => 'x' })

    expect(bumped).toEqual({ vwok: 'x' })
  })
})
