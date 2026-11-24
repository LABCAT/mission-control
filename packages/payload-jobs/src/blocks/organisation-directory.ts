import type { Block } from 'payload'

/**
 * The organisation directory block (PJ-38). It lists the tenant's public organisations on one
 * page, with type and size filters. The block only carries editorial settings: the organisations
 * are read at render time through the site key, so the block cannot show a private page.
 */
export const ORGANISATION_DIRECTORY_BLOCK = 'organisation-directory'

/**
 * The most organisations one directory page draws (PJ-36's guard, restated): the founder decision
 * is one page with no pagination for fewer than 100 organisations, and this keeps the page bounded
 * if a tenant grows past it.
 */
export const ORGANISATION_DIRECTORY_MAX = 200

export const organisationDirectoryBlock: Block = {
  slug: ORGANISATION_DIRECTORY_BLOCK,
  interfaceName: 'OrganisationDirectoryBlock',
  labels: { plural: 'Organisation directories', singular: 'Organisation directory' },
  fields: [
    { name: 'heading', type: 'text' },
    { name: 'intro', type: 'textarea' },
    {
      name: 'showTypeFilter',
      type: 'checkbox',
      defaultValue: true,
      label: 'Filter by organisation type',
    },
    {
      name: 'showSizeFilter',
      type: 'checkbox',
      defaultValue: true,
      label: 'Filter by organisation size',
    },
    {
      name: 'emptyLabel',
      type: 'text',
      admin: { description: 'Shown when no organisation matches.' },
    },
  ],
}
