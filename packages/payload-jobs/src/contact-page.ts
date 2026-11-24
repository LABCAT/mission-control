import type { CollectionSlug, Payload } from 'payload'

/**
 * The contact system page (PJ-102). Legacy vwok's /contact was a form plus a Google map, so a
 * site's contact page is the generic Form block pointing at a contact form, followed by the
 * generic Map block. This module owns the shape; the tenant's own field labels, address and
 * coordinates come from the host's seed, never from here.
 */

/** The form-builder field kinds a contact form uses. */
export const CONTACT_FIELD_KINDS = ['email', 'text', 'textarea'] as const

export type ContactFieldKind = (typeof CONTACT_FIELD_KINDS)[number]

export type ContactFormField = {
  kind: ContactFieldKind
  label: string
  /** The submitted field name, e.g. `company-name`. */
  name: string
  required?: boolean
  /** Payload form-builder width: 100 is a full row. */
  width?: number
}

export type ContactMap = {
  address?: string
  heading?: string
  height?: 'large' | 'medium' | 'small'
  latitude?: number
  longitude?: number
  provider?: 'google' | 'openstreetmap'
  title?: string
  zoom?: number
}

export type ContactPageSeed = {
  fields: ContactFormField[]
  /** Heading above the form block. */
  heading?: string
  intro?: string
  map: ContactMap
  /** The form's title in the Forms collection, also how a re-run finds it. */
  formTitle: string
  /** Label on the submit button, when the form builder's default is not wanted. */
  submitButtonLabel?: string
}

/** The document the form builder stores in the Forms collection. */
export const contactFormData = (seed: ContactPageSeed): Record<string, unknown> => ({
  fields: seed.fields.map((field) => ({
    blockType: field.kind,
    label: field.label,
    name: field.name,
    required: field.required === true,
    width: field.width ?? 100,
  })),
  title: seed.formTitle,
  ...(seed.submitButtonLabel ? { submitButtonLabel: seed.submitButtonLabel } : {}),
})

/** The page's two blocks, in the order the legacy page showed them: form, then map. */
export const contactPageLayout = (
  formID: number | string,
  seed: ContactPageSeed,
): Record<string, unknown>[] => [
  {
    blockType: 'form',
    form: formID,
    ...(seed.heading ? { heading: seed.heading } : {}),
    ...(seed.intro ? { intro: seed.intro } : {}),
  },
  { blockType: 'map', ...seed.map },
]

export type SeedContactPageArgs = {
  formsSlug?: string
  pagesSlug?: string
  seed: ContactPageSeed
  tenantID: number | string
}

export type SeedContactPageResult = {
  formCreated: boolean
  formID: number | string
  pageID: number | string
  /** Blocks appended to the page on this run; empty when it already had both. */
  blocksAdded: string[]
}

type Doc = { id: number | string; layout?: null | { blockType?: string }[] }

/**
 * Create the site's contact form and give its contact system page the Form and Map blocks.
 *
 * Idempotent: the form is matched by title, the page by its `contact` role, and a block type
 * already on the page is never added twice. An editor's own edits are left alone.
 */
export const seedContactPage = async (
  payload: Payload,
  {
    formsSlug = 'forms',
    pagesSlug = 'pages',
    seed,
    tenantID,
  }: SeedContactPageArgs,
): Promise<SeedContactPageResult> => {
  const { docs: forms } = await payload.find({
    collection: formsSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      and: [{ tenant: { equals: tenantID } }, { title: { equals: seed.formTitle } }],
    },
  })

  let formID = forms[0]?.id
  const formCreated = formID === undefined

  if (formCreated) {
    const created = await payload.create({
      collection: formsSlug as CollectionSlug,
      data: { ...contactFormData(seed), tenant: tenantID } as never,
      overrideAccess: true,
    })
    formID = created.id
  }

  const { docs: pages } = await payload.find({
    collection: pagesSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      and: [{ tenant: { equals: tenantID } }, { role: { equals: 'contact' } }],
    },
  })

  const page = pages[0] as Doc | undefined
  const layout = page?.layout ?? []
  const wanted = contactPageLayout(formID!, seed)
  const blocksAdded: string[] = []
  const additions = wanted.filter((block) => {
    const blockType = block.blockType as string
    if (layout.some((existing) => existing?.blockType === blockType)) return false
    blocksAdded.push(blockType)
    return true
  })

  if (!page) {
    const created = await payload.create({
      collection: pagesSlug as CollectionSlug,
      data: {
        _status: 'published',
        layout: additions,
        role: 'contact',
        slug: 'contact',
        tenant: tenantID,
        title: 'Contact',
      } as never,
      overrideAccess: true,
    })

    return { blocksAdded, formCreated, formID: formID!, pageID: created.id }
  }

  if (additions.length > 0) {
    await payload.update({
      collection: pagesSlug as CollectionSlug,
      data: { layout: [...layout, ...additions] } as never,
      id: page.id,
      overrideAccess: true,
    })
  }

  return { blocksAdded, formCreated, formID: formID!, pageID: page.id }
}
