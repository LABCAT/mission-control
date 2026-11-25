import {
  BlocksFeature,
  BoldFeature,
  HeadingFeature,
  ItalicFeature,
  lexicalEditor,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  UnderlineFeature,
  UnorderedListFeature,
} from '@payloadcms/richtext-lexical'
import type { Block, CollectionConfig, Field } from 'payload'

import { authenticatedAccess, isSeekerOnly } from '../access'
import { pageWriteAccess } from '../collections/pages'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'
import { subjectTokens, type EmailEventRegistry } from './events'
import { chipsOf } from './lexical'

export const EMAIL_TEMPLATES_SLUG = 'email-templates'
export const SUBJECT_FIELD_COMPONENT_PATH = '@mission-control/payload-jobs/client#EmailSubjectField'

export type EmailTemplatesOptions = {
  access?: CollectionAccess
  events: EmailEventRegistry
  slug?: string
  tenantScoped?: boolean
}

/** The variables an event offers, as the subject picker needs them. */
export const variablesByEvent = (events: EmailEventRegistry): Record<string, { key: string; label: string }[]> =>
  Object.fromEntries(
    [...events.values()].map((event) => [event.slug, event.variables.map(({ key, label }) => ({ key, label }))]),
  )

const unionOptions = (items: { key: string; label: string }[]): { label: string; value: string }[] => {
  const seen = new Map<string, string>()
  for (const item of items) if (!seen.has(item.key)) seen.set(item.key, item.label)

  return [...seen].map(([value, label]) => ({ label, value }))
}

/**
 * The chips as editor blocks. The "variable" chip is an inline block that shows as a chip in the
 * text; the block chip ("Job list") is a developer-built block. Their `key` options are the union
 * over all events, and the template validation narrows them to the template's own event.
 */
export const chipBlocks = (events: EmailEventRegistry): { blocks: Block[]; inlineBlocks: Block[] } => {
  const all = [...events.values()]
  const variableOptions = unionOptions(all.flatMap((event) => event.variables))
  const blockOptions = unionOptions(all.flatMap((event) => event.blocks ?? []))

  return {
    blocks:
      blockOptions.length > 0
        ? [
            {
              slug: 'emailBlock',
              fields: [{ name: 'key', type: 'select', options: blockOptions, required: true }],
              labels: { plural: 'Blocks', singular: 'Block' },
            },
          ]
        : [],
    inlineBlocks: [
      {
        slug: 'variable',
        fields: [{ name: 'key', type: 'select', options: variableOptions, required: true }],
        labels: { plural: 'Variables', singular: 'Variable' },
      },
    ],
  }
}

const templateEditor = (events: EmailEventRegistry) => {
  const { blocks, inlineBlocks } = chipBlocks(events)

  return lexicalEditor({
    features: () => [
      ParagraphFeature(),
      HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3'] }),
      BoldFeature(),
      ItalicFeature(),
      UnderlineFeature(),
      LinkFeature(),
      UnorderedListFeature(),
      OrderedListFeature(),
      BlocksFeature({ blocks, inlineBlocks }),
    ],
  })
}

/** Chips and subject tokens a template may use, by the event it belongs to. */
export const unknownChips = (
  events: EmailEventRegistry,
  eventSlug: null | string | undefined,
  { body, subject }: { body?: unknown; subject?: null | string },
): string[] => {
  const event = eventSlug ? events.get(eventSlug) : undefined
  if (!event) return []
  const variables = new Set(event.variables.map((variable) => variable.key))
  const blocks = new Set((event.blocks ?? []).map((block) => block.key))
  const used = chipsOf(body)

  return [
    ...subjectTokens(subject ?? '').filter((key) => !variables.has(key)),
    ...used.variables.filter((key) => !variables.has(key)),
    ...used.blocks.filter((key) => !blocks.has(key)),
  ]
}

const fieldsFor = (events: EmailEventRegistry, tenantScoped: boolean): Field[] => [
  {
    name: 'event',
    type: 'select',
    required: true,
    index: true,
    // One template per event and site; the tenant+event index below covers it.
    ...(tenantScoped ? {} : { unique: true }),
    options: [...events.values()].map((event) => ({ label: event.label, value: event.slug })),
    admin: { description: 'The email this text is for. The variables you can insert depend on it.' },
  },
  {
    name: 'enabled',
    type: 'checkbox',
    defaultValue: true,
    admin: {
      description: 'Untick to stop sending this email on this site. Skipped sends are logged.',
      position: 'sidebar',
    },
  },
  {
    name: 'subject',
    type: 'text',
    admin: {
      components: { Field: { clientProps: { variablesByEvent: variablesByEvent(events) }, path: SUBJECT_FIELD_COMPONENT_PATH } },
      description: 'Plain text. Use “Insert variable” to add the person’s name, the job title and so on. Empty uses the standard subject.',
    },
    validate: (value: null | string | undefined, { siblingData }: { siblingData?: Record<string, unknown> }) => {
      const unknown = unknownChips(events, siblingData?.event as string, { subject: value })

      return unknown.length === 0 ? true : `This email has no variable “${unknown[0]}”`
    },
  },
  {
    name: 'body',
    type: 'richText',
    editor: templateEditor(events),
    admin: { description: 'Empty uses the standard text. Variables show as chips; the site’s logo, colours and footer are added around it.' },
    validate: (value: unknown, { siblingData }: { siblingData?: Record<string, unknown> }) => {
      const unknown = unknownChips(events, siblingData?.event as string, { body: value })

      return unknown.length === 0 ? true : `This email has no variable “${unknown[0]}”`
    },
  },
]

/**
 * Per-tenant email templates (PJ-50, decision 19 Nov). Subject = plain text with an "Insert
 * variable" picker; body = Lexical with variable chips. One template per event and site; the
 * `enabled` switch turns that event off for the site. No code or logic is exposed to editors.
 */
export const emailTemplatesCollection = ({
  access,
  events,
  slug = EMAIL_TEMPLATES_SLUG,
  tenantScoped = true,
}: EmailTemplatesOptions): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    {
      create: pageWriteAccess(tenantScoped),
      delete: pageWriteAccess(tenantScoped),
      read: (args) => (isSeekerOnly(args.req.user as never) ? false : authenticatedAccess(args)),
      update: pageWriteAccess(tenantScoped),
    },
    access,
  ),
  admin: {
    defaultColumns: ['event', 'enabled', 'subject'],
    description: 'The text of each email this site sends.',
    group: 'Settings',
    useAsTitle: 'event',
  },
  fields: fieldsFor(events, tenantScoped),
  indexes: tenantScoped ? [{ fields: ['tenant', 'event'], unique: true }] : [],
  versions: false,
})
