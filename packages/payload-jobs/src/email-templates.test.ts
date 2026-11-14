import type { Field } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  checkTemplatePlaceholders,
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_KEYS,
  placeholdersIn,
} from './email-template-defaults'
import { emailTemplatesCollection } from './email-templates'

const collection = emailTemplatesCollection()

const field = (name: string): Field => {
  const match = collection.fields.find(
    (candidate) => 'name' in candidate && candidate.name === name,
  )
  if (!match) throw new Error(`Missing field ${name}`)
  return match
}

const validate = (
  name: 'body' | 'subject',
  value: null | string,
  siblingData: Record<string, unknown>,
) => {
  const target = field(name)

  if (!('validate' in target) || typeof target.validate !== 'function') {
    throw new Error(`${name} has no validator`)
  }

  return target.validate(value, { siblingData } as never) as string | true
}

describe('email-templates collection', () => {
  it('has the tenant-scoped key, subject, body and enabled fields', () => {
    expect(collection.slug).toBe('email-templates')
    expect(collection.versions).toBe(false)

    const names = collection.fields
      .filter((candidate) => 'name' in candidate)
      .map((candidate) => (candidate as { name: string }).name)

    expect(names).toEqual(['key', 'subject', 'body', 'enabled'])

    for (const name of ['key', 'subject', 'body']) {
      expect(field(name)).toMatchObject({ required: true })
    }

    expect(field('enabled')).toMatchObject({ type: 'checkbox', defaultValue: true })
  })

  it('limits key to the templates the app sends', () => {
    const options = (field('key') as { options: { value: string }[] }).options.map(
      (option) => option.value,
    )

    expect(options).toEqual([...EMAIL_TEMPLATE_KEYS])
  })

  it('makes key unique within a tenant, not across tenants', () => {
    expect(collection.indexes).toEqual([{ fields: ['tenant', 'key'], unique: true }])
    expect(field('key')).not.toMatchObject({ unique: true })
  })

  it('makes key globally unique in single-tenant mode', () => {
    const single = emailTemplatesCollection({ tenantScoped: false })

    expect(single.indexes).toBeUndefined()
    expect(single.fields.find((candidate) => 'name' in candidate && candidate.name === 'key')).toMatchObject(
      { unique: true },
    )
  })

  it('leaves the tenant field to the multi-tenant plugin', () => {
    const names = collection.fields
      .filter((candidate) => 'name' in candidate)
      .map((candidate) => (candidate as { name: string }).name)

    expect(names).not.toContain('tenant')
  })
})

const accessFor = (operation: 'create' | 'delete' | 'read' | 'update', user: unknown) => {
  const check = collection.access?.[operation]
  if (typeof check !== 'function') throw new Error(`Missing ${operation} access`)

  return (check as (args: unknown) => boolean)({ req: { user } })
}

describe('email template access', () => {
  const tenantAdmin = {
    id: 1,
    role: 'user',
    tenants: [{ role: 'tenant-admin', tenant: 10 }],
  }
  const editor = { id: 2, role: 'user', tenants: [{ role: 'editor', tenant: 10 }] }
  const employer = { id: 3, role: 'user', tenants: [{ role: 'employer', tenant: 10 }] }
  const superAdmin = { id: 4, role: 'super-admin', tenants: [] }

  it('lets tenant-admins, editors and super-admins manage templates', () => {
    for (const operation of ['create', 'read', 'update', 'delete'] as const) {
      expect(accessFor(operation, tenantAdmin)).toBe(true)
      expect(accessFor(operation, editor)).toBe(true)
      expect(accessFor(operation, superAdmin)).toBe(true)
    }
  })

  it('keeps employers and anonymous requests out', () => {
    for (const operation of ['create', 'read', 'update', 'delete'] as const) {
      expect(accessFor(operation, employer)).toBe(false)
      expect(accessFor(operation, null)).toBe(false)
    }
  })
})

describe('email template validation', () => {
  it('accepts the placeholders the template declares', () => {
    expect(validate('subject', '[{{siteName}}] Job approved', { key: 'job_approved' })).toBe(true)
    expect(
      validate('body', '<p>Hi {{name}}, {{jobTitle}} is live at {{siteUrl}}.</p>', {
        key: 'job_approved',
      }),
    ).toBe(true)
  })

  it('rejects required fields that are empty', () => {
    expect(validate('subject', '', { key: 'job_approved' })).toBe('Subject is required')
    expect(validate('body', null, { key: 'job_approved' })).toBe('Body is required')
  })

  it('rejects a placeholder the template does not declare', () => {
    expect(validate('subject', 'Hi {{jobtitle}}', { key: 'job_approved' })).toContain(
      '{{jobtitle}}',
    )
    expect(
      validate('body', '<p>{{password}}</p>', { key: 'job_approved' }),
    ).toContain('{{password}}')
  })

  it('rejects an unclosed placeholder, which would otherwise send literally', () => {
    expect(validate('body', '<p>Hi {{name</p>', { key: 'job_approved' })).toBe(
      'Close every {{placeholder}} with }}',
    )
  })

  it('does not check placeholders when no template key is set yet', () => {
    expect(validate('subject', '{{anything}}', {})).toBe(true)
  })
})

describe('default templates', () => {
  it('has one default per key, in order', () => {
    expect(EMAIL_TEMPLATE_DEFAULTS.map((template) => template.key)).toEqual([
      ...EMAIL_TEMPLATE_KEYS,
    ])
    expect(new Set(EMAIL_TEMPLATE_KEYS).size).toBe(EMAIL_TEMPLATE_KEYS.length)
  })

  it('covers the emails AUDIT.md keeps and drops the rest', () => {
    // Account, jobs, applications, organisations, contact form and job alerts are kept;
    // resume access, featured add-ons and recurring payments are dropped.
    expect([...EMAIL_TEMPLATE_KEYS]).toEqual(
      expect.arrayContaining([
        'new_user',
        'resend_confirmation',
        'new_job_admin',
        'new_job',
        'job_approved',
        'expired_job',
        'new_application',
        'organisation_listing_request',
        'organisation_live',
        'contact_form',
        'job_alerts_digest',
      ]),
    )

    for (const dropped of ['resume_subscription_start', 'expired_pack', 'new_order_admin']) {
      expect(EMAIL_TEMPLATE_KEYS).not.toContain(dropped)
    }
  })

  it('only uses declared placeholders in its own subject and body', () => {
    for (const template of EMAIL_TEMPLATE_DEFAULTS) {
      const check = checkTemplatePlaceholders(template)
      expect({ key: template.key, ...check }).toEqual({ key: template.key, unknown: [] })
    }
  })

  it('derives each template’s placeholders from its own text', () => {
    for (const template of EMAIL_TEMPLATE_DEFAULTS) {
      const used = [...new Set([...placeholdersIn(template.subject), ...placeholdersIn(template.body)])]

      expect(template.placeholders).toEqual(used)
      expect(template.placeholders).toContain('siteName')
    }
  })

  it('declares no placeholder twice', () => {
    for (const template of EMAIL_TEMPLATE_DEFAULTS) {
      expect(new Set(template.placeholders).size).toBe(template.placeholders.length)
    }
  })

  it('never hardcodes a site name or URL', () => {
    for (const template of EMAIL_TEMPLATE_DEFAULTS) {
      expect(`${template.subject}${template.body}`).not.toMatch(/vanuatu\s*wok|vanuatuwok\.vu/i)
    }
  })

  it('subjects are single line and bodies are non-empty', () => {
    for (const template of EMAIL_TEMPLATE_DEFAULTS) {
      expect(template.subject).not.toContain('\n')
      expect(template.body.trim().length).toBeGreaterThan(0)
      expect(template.label.trim().length).toBeGreaterThan(0)
    }
  })
})
