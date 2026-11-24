import { describe, expect, it } from 'vitest'

import { formFields, formFrom, formIsMultiColumn, HONEYPOT_FIELD } from './form'
import type { FormData } from './types'

const form = (fields: FormData['fields']): FormData => ({
  fields,
  id: 7,
  title: 'Contact us',
})

describe('formFields', () => {
  it('keeps the submitted name and label of each field @S-320', () => {
    const fields = formFields(
      form([
        { blockType: 'text', label: 'Your name', name: 'name', required: true },
        { blockType: 'email', label: 'Email', name: 'email' },
      ]),
    )

    expect(fields).toEqual([
      expect.objectContaining({
        inputType: 'text',
        kind: 'text',
        label: 'Your name',
        name: 'name',
        required: true,
      }),
      expect.objectContaining({ inputType: 'email', kind: 'email', name: 'email' }),
    ])
  })

  it('falls back to the field name when the editor gave no label', () => {
    const [field] = formFields(form([{ blockType: 'text', name: 'company' }]))

    expect(field.label).toBe('company')
  })

  it('drops a field with no name, so it can never submit empty', () => {
    const fields = formFields(form([{ blockType: 'text', label: 'Anonymous' }]))

    expect(fields).toEqual([])
  })

  it('drops a block type the renderer does not draw, rather than guessing', () => {
    const fields = formFields(
      form([
        { blockType: 'payment', label: 'Pay', name: 'pay' },
        { blockType: 'textarea', label: 'Message', name: 'message' },
      ]),
    )

    expect(fields.map((field) => field.kind)).toEqual(['textarea'])
  })

  it('renders a message block as preformatted HTML with no control', () => {
    const message = { root: { children: [] } }
    const [field] = formFields(form([{ blockType: 'message', message }]), {
      richText: (value) => (value === message ? '<p>Ring us</p>' : ''),
    })

    expect(field).toMatchObject({ html: '<p>Ring us</p>', kind: 'message', name: '' })
  })

  it('turns select and radio options into label/value pairs', () => {
    const fields = formFields(
      form([
        {
          blockType: 'select',
          label: 'Reason',
          name: 'reason',
          options: [
            { label: 'Jobs', value: 'jobs' },
            { label: 'Broken', value: '' },
          ],
        },
      ]),
    )

    expect(fields[0]!.options).toEqual([{ label: 'Jobs', value: 'jobs' }])
  })

  it('keeps the first field when two share a name, so one answer is submitted', () => {
    const fields = formFields(
      form([
        { blockType: 'text', label: 'Name', name: 'name' },
        { blockType: 'email', label: 'Name again', name: 'name' },
      ]),
    )

    expect(fields).toHaveLength(1)
    expect(fields[0]!.label).toBe('Name')
  })

  it('treats a form that was not populated as having no fields', () => {
    expect(formFields(formFrom(12))).toEqual([])
  })

  it('reports a two-column layout only when an editor chose a narrow field', () => {
    expect(formIsMultiColumn(formFields(form([{ blockType: 'text', name: 'a' }])))).toBe(false)
    expect(
      formIsMultiColumn(formFields(form([{ blockType: 'text', name: 'a', width: 50 }]))),
    ).toBe(true)
  })

  it('names the honeypot something a person would not look for', () => {
    expect(HONEYPOT_FIELD).toBe('rp-website')
  })
})
