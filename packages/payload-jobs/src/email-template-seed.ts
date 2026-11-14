import type { CollectionSlug, Payload } from 'payload'

import {
  checkTemplatePlaceholders,
  EMAIL_TEMPLATE_DEFAULTS,
  type EmailTemplateDefinition,
} from './email-template-defaults'

/** The slice of the Payload API the seed needs. */
export type EmailTemplateSeedClient = Pick<Payload, 'create' | 'find'>

export type EmailTemplateSeedOptions = {
  payload: EmailTemplateSeedClient
  collection?: string
  /** Skip the writes and only report what would happen. */
  dryRun?: boolean
  /** The templates to seed. Defaults to `EMAIL_TEMPLATE_DEFAULTS`. */
  templates?: readonly EmailTemplateDefinition[]
  tenantID: number | string
}

export type EmailTemplateSeedResult = {
  created: string[]
  skipped: string[]
}

type ExistingTemplate = { key?: null | string }

/**
 * Fail before writing anything if a default's placeholders do not match its own
 * declaration: a broken default would otherwise ship an email with a blank value, or a
 * literal `{{placeholder}}`, where the real value belongs.
 */
export const assertDefaultTemplatesValid = (
  templates: readonly EmailTemplateDefinition[] = EMAIL_TEMPLATE_DEFAULTS,
): void => {
  for (const template of templates) {
    const check = checkTemplatePlaceholders(template)
    if ('message' in check) {
      throw new Error(`Default email template "${template.key}" is invalid: ${check.message}`)
    }
    if (check.unknown.length > 0) {
      throw new Error(
        `Default email template "${template.key}" uses undeclared placeholder {{${check.unknown[0]}}}`,
      )
    }
  }
}

/**
 * Create a tenant's email templates from the defaults. Existing templates are left
 * untouched, so re-running the seed never overwrites a tenant's edits.
 */
export const seedEmailTemplates = async ({
  payload,
  collection = 'email-templates',
  dryRun = false,
  templates = EMAIL_TEMPLATE_DEFAULTS,
  tenantID,
}: EmailTemplateSeedOptions): Promise<EmailTemplateSeedResult> => {
  assertDefaultTemplatesValid(templates)

  const { docs } = await payload.find({
    collection: collection as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { tenant: { equals: tenantID } },
  })

  const seedKeys = new Set<string>(templates.map((template) => template.key))

  const existing = new Set(
    (docs as ExistingTemplate[])
      .map((doc) => doc.key)
      .filter((key): key is string => typeof key === 'string' && seedKeys.has(key)),
  )

  const created: string[] = []
  const skipped: string[] = []

  for (const template of templates) {
    if (existing.has(template.key)) {
      skipped.push(template.key)
      continue
    }

    if (!dryRun) {
      await payload.create({
        collection: collection as CollectionSlug,
        data: {
          body: template.body,
          enabled: true,
          key: template.key,
          subject: template.subject,
          tenant: tenantID,
        } as never,
        overrideAccess: true,
      })
    }

    created.push(template.key)
  }

  return { created, skipped }
}
