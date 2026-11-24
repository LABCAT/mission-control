import type { Block } from 'payload'

/**
 * A map without an API key: an OpenStreetMap or Google Maps embed in a lazy iframe. The block
 * stores only content (where to look), never a key, so a site can show its address with no
 * account and no client-side JavaScript.
 */
export const mapBlock: Block = {
  slug: 'map',
  interfaceName: 'MapBlock',
  labels: { singular: 'Map', plural: 'Maps' },
  fields: [
    {
      name: 'heading',
      type: 'text',
    },
    {
      name: 'title',
      type: 'text',
      admin: { description: 'The map’s accessible name, e.g. “Our office on the map”.' },
    },
    {
      name: 'provider',
      type: 'select',
      defaultValue: 'openstreetmap',
      options: [
        { label: 'OpenStreetMap (no key)', value: 'openstreetmap' },
        { label: 'Google Maps embed (no key)', value: 'google' },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'latitude',
          type: 'number',
          min: -90,
          max: 90,
          admin: { step: 0.000001, width: '50%' },
        },
        {
          name: 'longitude',
          type: 'number',
          min: -180,
          max: 180,
          admin: { step: 0.000001, width: '50%' },
        },
      ],
    },
    {
      name: 'address',
      type: 'text',
      admin: {
        description: 'Coordinates take precedence; without them the map searches this address.',
      },
    },
    {
      name: 'zoom',
      type: 'number',
      defaultValue: 14,
      min: 1,
      max: 20,
      admin: { description: 'How close the map starts, from 1 (world) to 20 (street).' },
    },
    {
      name: 'height',
      type: 'select',
      defaultValue: 'medium',
      options: [
        { label: 'Small', value: 'small' },
        { label: 'Medium', value: 'medium' },
        { label: 'Large', value: 'large' },
      ],
    },
  ],
}
