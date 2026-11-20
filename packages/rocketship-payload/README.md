# @mission-control/rocketship-payload

Generic [Payload](https://payloadcms.com) block configs and zero-JS Astro renderers built on
[`@labcat2020/rocketship`](https://www.npmjs.com/package/@labcat2020/rocketship).

This package is intentionally generic: it has no dependency on `payload-jobs`, knows no tenant
values, and every renderer takes plain block data and never fetches. At publish time it moves to
the `@labcat2020` scope (the workspace name is `@mission-control/rocketship-payload`).

```bash
pnpm add @mission-control/rocketship-payload @labcat2020/rocketship
# only when the site renders rich-text or FAQ answers:
pnpm add @payloadcms/richtext-lexical
```

Each block has three entry points:

| Import                                    | What it is                          |
| ----------------------------------------- | ----------------------------------- |
| `…/blocks/<name>`                         | the Payload block config            |
| `…/astro/<name>`                          | the Astro renderer                  |
| `…/types`                                 | the block data types                |

The subpaths are deliberate: a site imports only the renderers it uses, so it bundles only those.

## Register the blocks (Payload)

Register the block configs once, then reference them by slug from a `blocks` field. Blocks that
show images take the host's upload collection slug; it defaults to `media`.

```ts
import {
  bannerBlock,
  cardGridBlock,
  ctaBlock,
  faqBlock,
  featureBoxesBlock,
  heroBlock,
  richTextBlock,
} from '@mission-control/rocketship-payload/blocks'

export default buildConfig({
  // …
  blocks: [
    heroBlock({ mediaSlug: 'media' }),
    featureBoxesBlock,
    richTextBlock,
    cardGridBlock({ mediaSlug: 'media' }),
    ctaBlock,
    faqBlock,
    bannerBlock({ mediaSlug: 'media' }),
  ],
})
```

A page field then names the blocks it allows:

```ts
{
  name: 'layout',
  type: 'blocks',
  blocks: ['hero', 'feature-boxes', 'rich-text', 'card-grid', 'cta', 'faq', 'banner'],
}
```

### Header banner

`headerBannerField()` is the site-settings field the layout renders on every page. It is a
`blocks` field capped at one `banner` block, and it carries its own banner config:

```ts
import { headerBannerField } from '@mission-control/rocketship-payload/blocks'

globals: [
  {
    slug: 'site-settings',
    fields: [headerBannerField({ mediaSlug: 'media' })],
  },
]
```

## Render the blocks (Astro)

`RenderBlocks` takes an explicit component map. An unknown block type renders nothing; in
development it also logs a warning. No renderer ships client JavaScript.

```astro
---
import RenderBlocks from '@mission-control/rocketship-payload/astro/render-blocks'
import Banner from '@mission-control/rocketship-payload/astro/banner'
import CardGrid from '@mission-control/rocketship-payload/astro/card-grid'
import Cta from '@mission-control/rocketship-payload/astro/cta'
import Faq from '@mission-control/rocketship-payload/astro/faq'
import FeatureBoxes from '@mission-control/rocketship-payload/astro/feature-boxes'
import Hero from '@mission-control/rocketship-payload/astro/hero'
import RichText from '@mission-control/rocketship-payload/astro/rich-text'
import type { BlockData } from '@mission-control/rocketship-payload/types'

const { blocks } = Astro.props as { blocks: BlockData[] }
const components = {
  banner: Banner,
  'card-grid': CardGrid,
  cta: Cta,
  faq: Faq,
  'feature-boxes': FeatureBoxes,
  hero: Hero,
  'rich-text': RichText,
}
---

<RenderBlocks blocks={blocks} components={components} />
```

The renderers use only Rocketship components and `--rs-*` tokens; a site's branding reaches them
through the normal Rocketship token overrides.

### Blocks

| Block           | Renderer      | Notes                                              |
| --------------- | ------------- | -------------------------------------------------- |
| `hero`          | `Hero`        | eyebrow, heading, body, optional image and links    |
| `feature-boxes` | `FeatureBoxes`| icon/title/body cards                               |
| `rich-text`     | `RichText`    | Lexical field converted to HTML                     |
| `card-grid`     | `CardGrid`    | image cards, 2–4 columns                            |
| `faq`           | `Faq`         | native `<details>` disclosures, rich-text answers   |
| `cta`           | `Cta`         | heading, body, links                                |
| `banner`        | `Banner`      | desktop/mobile `<picture>`, optional link, no CLS   |

## Local API helper

Sites that render inside the CMS process can read blocks with the Local API instead of REST:

```ts
import { findDocumentBlocks, findGlobalBlocks } from '@mission-control/rocketship-payload/local-api'

const { document, blocks } = await findDocumentBlocks(payload, {
  collection: 'pages',
  slug: 'about',
})

const settings = await findGlobalBlocks(payload, {
  field: 'headerBanner',
  slug: 'site-settings',
})
```

The helper only reads: it finds a document by `slug` (or reads a global), returns the named
field as block data, and leaves rendering to `RenderBlocks`. Job sites keep using the REST API
with a site key; this helper is for in-process sites.

## Rich text

`lexicalToHtml` is exported from `…/richtext` if a site needs to convert a Lexical field outside
the `rich-text`/`faq` renderers. It returns `''` for missing or malformed data instead of
throwing.

## Notes

- No block fetches data. The site loads the document, then passes its blocks to `RenderBlocks`.
- No tenant values (currency, timezone, labels, domain) live here.
- The `banner` renderer sets width/height and an aspect ratio from the image metadata, so the
  page does not shift while the image loads.
