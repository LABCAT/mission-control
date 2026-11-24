import type { Block, CollectionSlug } from 'payload'

export type FormBlockOptions = {
  /** The host's form-builder forms collection. Defaults to `forms`. */
  formsSlug?: string
}

/**
 * A form drawn from a document in the Payload form-builder plugin. The block only points at
 * the form; the fields, labels and confirmation live on that document, so one form can be
 * reused on several pages and each site keeps its own forms.
 */
export const formBlock = ({ formsSlug = 'forms' }: FormBlockOptions = {}): Block => ({
  slug: 'form',
  interfaceName: 'FormBlock',
  labels: { singular: 'Form', plural: 'Forms' },
  fields: [
    {
      name: 'heading',
      type: 'text',
    },
    {
      name: 'intro',
      type: 'textarea',
    },
    {
      name: 'form',
      type: 'relationship',
      relationTo: formsSlug as CollectionSlug,
      required: true,
      admin: { description: 'The form whose fields are shown, from the Forms collection.' },
    },
  ],
})
