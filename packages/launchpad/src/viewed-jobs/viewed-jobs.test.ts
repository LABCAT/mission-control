import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { has, list, record, VIEWED_JOBS_KEY, VIEWED_JOBS_LIMIT } from './index'

/** A minimal in-memory Storage, so the tests never depend on the Node version's globals. */
class MemoryStorage {
  private data = new Map<string, string>()

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  get length(): number {
    return this.data.size
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('viewed jobs', () => {
  it('records newest first and dedupes a job viewed twice', () => {
    record('a')
    record('b')
    record('a')

    expect(list()).toEqual(['a', 'b'])
    expect(has('a')).toBe(true)
    expect(has('c')).toBe(false)
  })

  it('keeps only the last 20 ids and honours a smaller limit', () => {
    for (let index = 0; index < VIEWED_JOBS_LIMIT + 5; index += 1) record(String(index))

    const all = list()
    expect(all).toHaveLength(VIEWED_JOBS_LIMIT)
    expect(all[0]).toBe(String(VIEWED_JOBS_LIMIT + 4))
    expect(all.at(-1)).toBe('5')

    expect(list(5)).toEqual(['24', '23', '22', '21', '20'])
    expect(list(0)).toEqual([])
    expect(list(-1)).toEqual([])
  })

  it('returns nothing when storage is unavailable, and never throws', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(() => record('a')).not.toThrow()
    expect(list()).toEqual([])
    expect(has('a')).toBe(false)
  })

  it('swallows a storage implementation that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })

    expect(() => record('a')).not.toThrow()
    expect(list()).toEqual([])
    expect(has('a')).toBe(false)
  })

  it('ignores malformed stored data instead of breaking the page', () => {
    storage.setItem(VIEWED_JOBS_KEY, '{"not":"an array"}')
    expect(list()).toEqual([])

    storage.setItem(VIEWED_JOBS_KEY, '["a", 2, "", "b", "a"]')
    expect(list()).toEqual(['a', 'b'])
  })
})
