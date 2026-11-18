import type { Config, ImageSize, UploadTransformer } from 'payload'

// mission-control: responsive image variants for a PageSpeed score of 100. Four widths, each
// as AVIF (smallest, newest) and WebP (wide support), so a site can serve `<picture>` with
// `srcset`. The original stays as the fallback. Never enlarge a small upload.
export const MEDIA_WIDTHS = [320, 640, 960, 1280] as const
export const MEDIA_FORMATS = ['avif', 'webp'] as const

export const mediaVariants: ImageSize[] = MEDIA_WIDTHS.flatMap((width) =>
  MEDIA_FORMATS.map(
    (format): ImageSize => ({
      name: `w${width}-${format}`,
      width,
      fit: 'inside',
      formatOptions: { format, options: format === 'avif' ? { quality: 60 } : { quality: 78 } },
      withoutEnlargement: true,
    }),
  ),
)

/**
 * Declares the `variants` fields on `media` without processing anything, so the database
 * schema is the same everywhere. sharp's own `init` does this projection too.
 */
const variantFieldsOnly: UploadTransformer = {
  init: (config: Config) => ({
    ...config,
    collections: config.collections?.map((collection) =>
      collection.slug === 'media' && typeof collection.upload === 'object'
        ? {
            ...collection,
            upload: {
              ...collection.upload,
              variants: mediaVariants.map(({ name }) => ({ name })),
            },
          }
        : collection,
    ),
  }),
  // Core requires a MIME type; `canTransform` keeps this from ever touching a file.
  canTransform: () => false,
  mimeTypes: ['image/*'],
  slug: 'media-variant-fields',
}

/**
 * Resizing needs sharp, a native module that cannot load in workerd (importing it there
 * crashes the whole Worker), so it is only imported under Node: the CLI, tests and import
 * scripts. In Workers uploads keep the original only until an image binding is chosen
 * (see docs/INFRA.md); the schema is identical either way.
 */
export const createMediaTransformers = async (isWorkers: boolean): Promise<UploadTransformer[]> => {
  if (isWorkers) return [variantFieldsOnly]

  const { sharpTransformer } = await import('@payloadcms/transformer-sharp')

  return [sharpTransformer({ collections: { media: { variants: mediaVariants } } })]
}
