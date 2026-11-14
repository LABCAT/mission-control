import { describe, expect, it } from 'vitest'

import { EMAIL_TEMPLATE_DEFAULTS } from './email-template-defaults'
import { seedEmailTemplates, type EmailTemplateSeedClient } from './email-template-seed'

type Created = { data: Record<string, unknown> }
type Found = { collection?: string; where?: unknown }

const fakePayload = (existing: { key: string; tenant: number }[] = []) => {
  const created: Created[] = []
  const finds: Found[] = []

  const payload: EmailTemplateSeedClient = {
    find: (async (args: Found) => {
      finds.push(args)
      const tenantID = (args.where as { tenant?: { equals?: unknown } } | undefined)?.tenant
        ?.equals

      return { docs: existing.filter((doc) => doc.tenant === tenantID) }
    }) as never,
    create: (async (args: Created) => {
      created.push(args)
      return { id: created.length, ...args.data }
    }) as never,
  }

  return { created, finds, payload }
}

describe('seedEmailTemplates', () => {
  it('creates one template per default key for the tenant', async () => {
    const { created, payload } = fakePayload()
    const result = await seedEmailTemplates({ payload, tenantID: 7 })

    expect(result).toEqual({ created: EMAIL_TEMPLATE_DEFAULTS.map((template) => template.key), skipped: [] })
    expect(created).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length)

    for (const [index, template] of EMAIL_TEMPLATE_DEFAULTS.entries()) {
      expect(created[index]?.data).toEqual({
        body: template.body,
        enabled: true,
        key: template.key,
        subject: template.subject,
        tenant: 7,
      })
    }
  })

  it('reads the tenant’s templates with access control overridden', async () => {
    const { finds, payload } = fakePayload()
    await seedEmailTemplates({ payload, tenantID: 7 })

    expect(finds).toEqual([
      expect.objectContaining({
        collection: 'email-templates',
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: 7 } },
      }),
    ])
  })

  it('writes with access control overridden, because the seed runs as system code', async () => {
    const created: Record<string, unknown>[] = []
    const payload = {
      find: async () => ({ docs: [] }),
      create: async (args: { overrideAccess?: boolean }) => {
        created.push(args as unknown as Record<string, unknown>)
        return {}
      },
    } as unknown as EmailTemplateSeedClient

    await seedEmailTemplates({ payload, tenantID: 7 })

    expect(created).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length)
    expect(created.every((args) => args.overrideAccess === true)).toBe(true)
  })

  it('never overwrites a template the tenant has edited', async () => {
    const { created, payload } = fakePayload([
      { key: 'new_user', tenant: 7 },
      { key: 'job_approved', tenant: 7 },
    ])

    const result = await seedEmailTemplates({ payload, tenantID: 7 })

    expect(result.skipped).toEqual(['new_user', 'job_approved'])
    expect(result.created).not.toContain('new_user')
    expect(created).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length - 2)
  })

  it('is idempotent: a second run creates nothing', async () => {
    const stored = EMAIL_TEMPLATE_DEFAULTS.map((template) => ({ key: template.key, tenant: 7 }))
    const { created, payload } = fakePayload(stored)

    const result = await seedEmailTemplates({ payload, tenantID: 7 })

    expect(result.created).toEqual([])
    expect(result.skipped).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length)
    expect(created).toEqual([])
  })

  it('keeps tenants apart, so seeding B leaves A’s templates alone', async () => {
    const stored = EMAIL_TEMPLATE_DEFAULTS.map((template) => ({ key: template.key, tenant: 1 }))
    const { created, payload } = fakePayload(stored)

    const result = await seedEmailTemplates({ payload, tenantID: 2 })

    expect(result.created).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length)
    expect(created.every((args) => args.data.tenant === 2)).toBe(true)
  })

  it('ignores stored keys that are no longer sent', async () => {
    const { created, payload } = fakePayload([{ key: 'resume_subscription_start', tenant: 7 }])

    await seedEmailTemplates({ payload, tenantID: 7 })

    expect(created).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length)
  })

  it('reports what it would do without writing when dryRun is set', async () => {
    const { created, payload } = fakePayload()
    const result = await seedEmailTemplates({ dryRun: true, payload, tenantID: 7 })

    expect(result.created).toHaveLength(EMAIL_TEMPLATE_DEFAULTS.length)
    expect(created).toEqual([])
  })

  it('refuses to seed a default that uses a placeholder it does not declare', async () => {
    const { created, payload } = fakePayload()
    const broken = {
      ...EMAIL_TEMPLATE_DEFAULTS[0]!,
      body: '<p>Hi {{nickname}}</p>',
    }

    await expect(
      seedEmailTemplates({ payload, templates: [broken], tenantID: 7 }),
    ).rejects.toThrow('undeclared placeholder {{nickname}}')

    expect(created).toEqual([])
  })

  it('refuses to seed a default with an unclosed placeholder', async () => {
    const { created, payload } = fakePayload()
    const broken = { ...EMAIL_TEMPLATE_DEFAULTS[0]!, subject: 'Hi {{name' }

    await expect(
      seedEmailTemplates({ payload, templates: [broken], tenantID: 7 }),
    ).rejects.toThrow('is invalid')

    expect(created).toEqual([])
  })
})
