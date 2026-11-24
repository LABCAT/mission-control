import { describe, expect, it } from 'vitest'

import { contactFormData, contactPageLayout } from '@mission-control/payload-jobs'

import { vwokContact } from './vwok-contact'

describe('vwok contact page seed @S-323', () => {
  it('keeps the legacy contact fields, with the two the old form required', () => {
    expect(vwokContact.fields.map((field) => field.label)).toEqual([
      'Your Name',
      'Company Name',
      'Your email',
      'Message',
    ])

    expect(vwokContact.fields.filter((field) => field.required).map((field) => field.name)).toEqual([
      'your-name',
      'your-email',
      'message',
    ])
  })

  it('stores the fields as form-builder blocks with unique names', () => {
    const data = contactFormData(vwokContact) as { fields: { blockType: string; name: string }[] }

    expect(data.fields.map((field) => field.blockType)).toEqual(['text', 'text', 'email', 'textarea'])
    expect(new Set(data.fields.map((field) => field.name)).size).toBe(data.fields.length)
  })

  it('puts the form before the map, as the legacy page did', () => {
    const layout = contactPageLayout(12, vwokContact)

    expect(layout.map((block) => block.blockType)).toEqual(['form', 'map'])
    expect(layout[0]).toMatchObject({ form: 12, heading: 'Contact us' })
  })

  it('centres the map on a real point, so the block draws one', () => {
    const map = contactPageLayout(1, vwokContact)[1] as { latitude: number; longitude: number }

    expect(map.latitude).toBeCloseTo(-17.7495, 3)
    expect(map.longitude).toBeCloseTo(168.3149, 3)
  })
})
