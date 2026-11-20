import { describe, expect, it } from 'vitest'

import { decodeLegacyEntities, legacySlug, legacySlugPart, legacyText } from './legacy-text'

describe('decodeLegacyEntities', () => {
  it('decodes the named and numeric entities WordPress stores in term names', () => {
    expect(decodeLegacyEntities('Construction &amp; roading')).toBe('Construction & roading')
    expect(decodeLegacyEntities('Experienced CHEF/ BAR/ KITCHEN &#038; OFFICE')).toBe(
      'Experienced CHEF/ BAR/ KITCHEN & OFFICE',
    )
    expect(decodeLegacyEntities('Vt 0 &#8211; 1,000,000')).toBe('Vt 0 – 1,000,000')
    expect(decodeLegacyEntities('Board&nbsp;position')).toBe('Board position')
    expect(decodeLegacyEntities('it&#8217;s')).toBe('it’s')
  })

  it('leaves unknown entities and bare ampersands alone instead of dropping them', () => {
    expect(decodeLegacyEntities('Rock & Roll')).toBe('Rock & Roll')
    expect(decodeLegacyEntities('&notanentity; & &#;')).toBe('&notanentity; & &#;')
    expect(decodeLegacyEntities('&#xZZ;')).toBe('&#xZZ;')
  })
})

describe('legacyText', () => {
  it('decodes entities and removes markup and repeated spaces', () => {
    expect(legacyText('<strong>Port&nbsp;Vila</strong>  ,  Efate')).toBe('Port Vila , Efate')
    expect(legacyText('   ')).toBe('')
    expect(legacyText(null)).toBe('')
    expect(legacyText(undefined)).toBe('')
  })
})

describe('legacySlugPart', () => {
  it('produces a slug the collection validators accept', () => {
    const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

    for (const name of [
      'Hospitality & Tourism',
      'Non Government Organisation (NGO)',
      '22 Anywhere/Work From Home',
      'Éfaté',
      '  Trades & Services  ',
    ]) {
      const slug = legacySlugPart(name)
      expect(slug, name).toMatch(pattern)
    }
  })

  it('strips accents, punctuation and surrounding separators', () => {
    expect(legacySlugPart('Éfaté')).toBe('efate')
    expect(legacySlugPart('Construction & roading')).toBe('construction-roading')
    expect(legacySlugPart('---Already---')).toBe('already')
    expect(legacySlugPart('4,000,000+')).toBe('4-000-000')
  })

  it('returns an empty string when there is nothing usable', () => {
    expect(legacySlugPart('!!!')).toBe('')
    expect(legacySlugPart('')).toBe('')
  })
})

describe('legacySlug', () => {
  it('prefers the legacy slug but falls back to the name', () => {
    expect(legacySlug('full-time', 'Full-Time')).toBe('full-time')
    expect(legacySlug('!!!', 'Full-Time')).toBe('full-time')
    expect(legacySlug(null, 'Full-Time')).toBe('full-time')
  })

  it('reports null when neither the slug nor the name has a usable character', () => {
    expect(legacySlug('', '!!!')).toBeNull()
    expect(legacySlug(undefined, null)).toBeNull()
  })
})
