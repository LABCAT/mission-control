/**
 * The share image's layout (PJ-105): a satori element tree built from an `OgCard`.
 *
 * Kept apart from `render.ts` so the shape can be asserted without the WASM renderer: the tree
 * is plain data. Colours and text all come from the card, which comes from the tenant.
 *
 * Satori needs an explicit `display: flex` on every node with more than one child, and it has no
 * CSS cascade: every style is written where it applies.
 */
import type { OgCard } from './card'

/** The subset of satori's element shape used here, so this package needs no React types. */
export type SatoriNode = {
  props: Record<string, unknown>
  type: string
}

export type OgFont = {
  data: ArrayBuffer | Uint8Array
  name: string
  style?: 'italic' | 'normal'
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
}

const SURFACE = '#ffffff'
const INK = '#111827'
const MUTED = '#4b5563'
const FAINT = '#6b7280'
const RULE = '#e5e7eb'

const LOGO_SIZE = 72

/**
 * One 1200x630 card: the tenant's accent as a top rule, its logo and name, the page's title,
 * a subtitle and up to three fact pills, and the site's name in the footer.
 */
export const ogLayout = (card: OgCard): SatoriNode => {
  const header: SatoriNode = {
    props: {
      style: { alignItems: 'center', display: 'flex' },
      children: [
        ...(card.logo
          ? [
              {
                props: {
                  height: LOGO_SIZE,
                  src: card.logo.url,
                  style: { objectFit: 'contain', borderRadius: 8 },
                  width: LOGO_SIZE,
                },
                type: 'img',
              } satisfies SatoriNode,
            ]
          : []),
        {
          props: {
            style: {
              color: card.accent,
              display: 'flex',
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: 3,
              marginLeft: card.logo ? 24 : 0,
              textTransform: 'uppercase',
            },
            children: card.eyebrow,
          },
          type: 'div',
        },
      ],
    },
    type: 'div',
  }

  const body: SatoriNode[] = [
    {
      props: {
        style: {
          color: INK,
          display: 'flex',
          fontSize: card.title.length > 44 ? 60 : 72,
          fontWeight: 700,
          lineHeight: 1.15,
          marginTop: 40,
        },
        children: card.title,
      },
      type: 'div',
    },
  ]

  if (card.subtitle) {
    body.push({
      props: {
        style: { color: MUTED, display: 'flex', fontSize: 38, marginTop: 20 },
        children: card.subtitle,
      },
      type: 'div',
    })
  }

  if (card.facts.length > 0) {
    body.push({
      props: {
        style: { display: 'flex', marginTop: 34 },
        children: card.facts.map(
          (fact, index): SatoriNode => ({
            props: {
              style: {
                backgroundColor: card.accent,
                borderRadius: 999,
                color: card.accentText,
                display: 'flex',
                fontSize: 26,
                marginRight: index === card.facts.length - 1 ? 0 : 16,
                paddingBottom: 10,
                paddingLeft: 24,
                paddingRight: 24,
                paddingTop: 10,
              },
              children: fact,
            },
            type: 'div',
          }),
        ),
      },
      type: 'div',
    })
  }

  const footer: SatoriNode = {
    props: {
      style: {
        alignItems: 'flex-end',
        borderTop: `2px solid ${RULE}`,
        display: 'flex',
        justifyContent: 'space-between',
        paddingTop: 26,
      },
      children: [
        {
          props: {
            style: { color: INK, display: 'flex', fontSize: 30, fontWeight: 700 },
            children: card.siteName,
          },
          type: 'div',
        },
        {
          props: {
            style: { color: FAINT, display: 'flex', fontSize: 24 },
            children: OG_LABEL[card.kind],
          },
          type: 'div',
        },
      ],
    },
    type: 'div',
  }

  return {
    props: {
      style: {
        backgroundColor: SURFACE,
        borderTop: `16px solid ${card.accent}`,
        display: 'flex',
        height: '100%',
        width: '100%',
      },
      children: [
        {
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1,
              justifyContent: 'space-between',
              paddingBottom: 48,
              paddingLeft: 72,
              paddingRight: 72,
              paddingTop: 56,
            },
            children: [
              {
                props: { style: { display: 'flex', flexDirection: 'column' }, children: [header, ...body] },
                type: 'div',
              },
              footer,
            ],
          },
          type: 'div',
        },
      ],
    },
    type: 'div',
  }
}

const OG_LABEL: Record<OgCard['kind'], string> = {
  home: '',
  job: 'Job vacancy',
  organisation: 'Organisation',
}
