import type { Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { SEO_GROUP, SEO_TAB_LABEL, seoCollapsible, seoFields, seoTab } from './seo-fields'

const namesOf = (fields: Field[]): string[] => fields.map((field) => ('name' in field ? (field.name ?? '') : ''))

describe('the one SEO tab (PJ-104) @S-349', () => {
  it('keeps the group name the theme already reads', () => {
    expect(SEO_GROUP).toBe('seo')
  })

  it('offers title, description and noIndex, and no share image without an upload collection', () => {
    const field = seoFields() as { fields: Field[]; name: string; type: string }

    expect(field).toMatchObject({ name: 'seo', type: 'group' })
    expect(namesOf(field.fields)).toEqual(['title', 'description', 'noIndex'])
  })

  it('adds the share image only when the host has an upload collection', () => {
    const field = seoFields({ mediaSlug: 'media' }) as { fields: Field[] }

    expect(namesOf(field.fields)).toEqual(['title', 'description', 'image', 'noIndex'])
    expect(field.fields[2]).toMatchObject({ name: 'image', relationTo: 'media', type: 'upload' })
  })

  it('wraps the group in a tab named SEO, for a collection with no other tabs', () => {
    const tab = seoTab() as { tabs: { fields: Field[]; label: string }[]; type: string }

    expect(tab.type).toBe('tabs')
    expect(tab.tabs.map((entry) => entry.label)).toEqual([SEO_TAB_LABEL])
    expect(namesOf(tab.tabs[0]!.fields)).toEqual(['seo'])
  })

  it('folds the same group into a collapsible for a form with no tab bar', () => {
    const collapsible = seoCollapsible() as { fields: Field[]; label: string; type: string }

    expect(collapsible).toMatchObject({ label: SEO_TAB_LABEL, type: 'collapsible' })
    expect(namesOf(collapsible.fields)).toEqual(['seo'])
  })

  it('defaults noIndex to false, so a saved document is indexable unless someone says not', () => {
    const field = seoFields() as { fields: { name?: string; defaultValue?: unknown }[] }
    const noIndex = field.fields.find((entry) => entry.name === 'noIndex')

    expect(noIndex).toMatchObject({ defaultValue: false })
  })
})
