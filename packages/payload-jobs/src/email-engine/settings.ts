import {
  BoldFeature,
  ItalicFeature,
  lexicalEditor,
  LinkFeature,
  ParagraphFeature,
  UnderlineFeature,
} from '@payloadcms/richtext-lexical'
import type { Field } from 'payload'

import {
  DEFAULT_LOG_DELETE_MONTHS,
  DEFAULT_LOG_VISIBLE_DAYS,
} from './log-policy'

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const colourValidate = (value: null | string | undefined): string | true =>
  !value || HEX.test(value.trim()) ? true : 'Use a hex colour such as #1f4e79'

const periodValidate =
  (noun: string) =>
  (value: null | number | undefined): string | true =>
    value === null || value === undefined || (Number.isSafeInteger(value) && value >= 1)
      ? true
      : `Use a whole number of ${noun}, at least 1`

/**
 * The tenant's email look (logo, colours, footer) and how long its email log is kept (PJ-50).
 * Appended to the tenants collection (or the single-tenant settings global). One layout serves
 * every template; these are the only per-tenant parts of it.
 */
export const tenantEmailFields = (condition?: (data: Record<string, unknown>) => boolean): Field[] => [
  {
    name: 'emailBranding',
    type: 'group',
    admin: { ...(condition ? { condition } : {}), description: 'How this site’s emails look.' },
    fields: [
      {
        name: 'logoUrl',
        type: 'text',
        admin: { description: 'Address of the logo image (https). Shown at the top of every email.' },
        validate: (value: null | string | undefined) =>
          !value || /^https:\/\/\S+$/i.test(value.trim()) ? true : 'Use a full https:// address',
      },
      {
        name: 'brandColour',
        type: 'text',
        admin: { description: 'Header band and link colour, e.g. #1f4e79. Empty uses the standard blue.' },
        validate: colourValidate,
      },
      {
        name: 'backgroundColour',
        type: 'text',
        admin: { description: 'Colour behind the email card, e.g. #f4f4f5.' },
        validate: colourValidate,
      },
      {
        name: 'footer',
        type: 'richText',
        // Its own small editor: a tenant field cannot rely on the host having a default one.
        editor: lexicalEditor({
          features: () => [ParagraphFeature(), BoldFeature(), ItalicFeature(), UnderlineFeature(), LinkFeature()],
        }),
        admin: { description: 'Shown at the bottom of every email: address, unsubscribe note and so on.' },
      },
    ],
  },
  {
    name: 'emailLogRetention',
    type: 'group',
    admin: {
      ...(condition ? { condition } : {}),
      description:
        'The email log keeps no message text. Recipient addresses are masked, then rows deleted, by the nightly job.',
    },
    fields: [
      {
        name: 'visibleDays',
        type: 'number',
        defaultValue: DEFAULT_LOG_VISIBLE_DAYS,
        min: 1,
        admin: { description: 'Days the recipient address stays readable, then j***@example.com. Default 90.', step: 1 },
        validate: periodValidate('days'),
      },
      {
        name: 'deleteMonths',
        type: 'number',
        defaultValue: DEFAULT_LOG_DELETE_MONTHS,
        min: 1,
        admin: { description: 'Months before a log row is deleted. Default 12.', step: 1 },
        validate: periodValidate('months'),
      },
    ],
  },
]
