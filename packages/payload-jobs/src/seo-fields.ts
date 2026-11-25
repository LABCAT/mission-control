/**
 * The one SEO tab (PJ-104, founder decision 19 Nov). Pages, jobs and organisations all carry the
 * same overrides, in the same group, so a site manager learns one form and structured data keeps
 * being generated from content rather than typed into a second tab.
 *
 * The fields are overrides, not content: an empty title or description falls back to what the page
 * already shows, so filling nothing is a valid answer and nothing here duplicates the body.
 *
 * The group is named `seo`, which is the shape the theme already reads (`page.seo.title`); the tab
 * around it is presentational, so wrapping the group in a tab changes no column.
 */
import type { Field } from 'payload'

/** The group name, which is also the data path the theme reads: `seo.title`. */
export const SEO_GROUP = 'seo'

export type SeoFieldsOptions = {
  /**
   * The host's upload collection for the sharing image. `null` drops the field, which is what a
   * job or an organisation wants: its share image is generated (PJ-105), not uploaded.
   */
  mediaSlug?: null | string
}

export const seoFields = ({ mediaSlug = null }: SeoFieldsOptions = {}): Field => ({
  name: SEO_GROUP,
  type: 'group',
  admin: {
    description: 'Overrides for the page metadata. Empty fields fall back to the title.',
  },
  fields: [
    { name: 'title', type: 'text', admin: { description: 'Browser tab and search result title.' } },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'Meta description, ideally 50 to 160 characters.' },
    },
    ...(mediaSlug
      ? ([
          {
            name: 'image',
            type: 'upload',
            relationTo: mediaSlug,
            admin: { description: 'Open Graph image. Falls back to the site-wide default.' },
          },
        ] as Field[])
      : []),
    {
      name: 'noIndex',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Ask search engines not to index this page.' },
    },
  ],
})

/** The label of the tab every SEO group sits in. */
export const SEO_TAB_LABEL = 'SEO'

/** A whole `tabs` field holding just the SEO group, for a collection with no other tabs. */
export const seoTab = (options: SeoFieldsOptions = {}): Field => ({
  type: 'tabs',
  tabs: [{ label: SEO_TAB_LABEL, fields: [seoFields(options)] }],
})

/**
 * The same group folded into a collapsible, for a form that already uses collapsibles and has no
 * tab bar: a lone tab in the middle of a long form reads as a mistake. The field name and data
 * path are the tab's, so only the admin presentation differs.
 */
export const seoCollapsible = (options: SeoFieldsOptions = {}): Field => ({
  type: 'collapsible',
  label: SEO_TAB_LABEL,
  fields: [seoFields(options)],
})
