import { describe, expect, it } from 'vitest'

import { PAGE_ROLES, SYSTEM_PAGE_SEEDS, isSystemPage, pageRoleOptions } from './system-pages'

describe('system page seeds', () => {
  it('seeds one page per role, and home is the page at /', () => {
    expect(SYSTEM_PAGE_SEEDS.map((seed) => seed.role)).toEqual([...PAGE_ROLES])
    expect(SYSTEM_PAGE_SEEDS.find((seed) => seed.role === 'home')?.slug).toBeNull()
  })

  it('gives about, contact and organisations a slug and the home page none', () => {
    const byRole = Object.fromEntries(SYSTEM_PAGE_SEEDS.map((seed) => [seed.role, seed]))

    expect(byRole.home?.slug).toBeNull()
    expect(byRole.about?.slug).toBe('about')
    expect(byRole.contact?.slug).toBe('contact')
    expect(byRole.organisations?.slug).toBe('organisations')
  })

  it('offers every role as a select option, labelled for the admin', () => {
    expect(pageRoleOptions.map((option) => option.value)).toEqual([...PAGE_ROLES])
    expect(pageRoleOptions.every((option) => Boolean(option.label))).toBe(true)
  })

  it('treats a page as a system page only when it has a role', () => {
    expect(isSystemPage({ role: 'about' })).toBe(true)
    expect(isSystemPage({ role: null })).toBe(false)
    expect(isSystemPage(undefined)).toBe(false)
  })
})
