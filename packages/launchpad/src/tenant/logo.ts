/**
 * The header logo is shown at most this wide, in CSS pixels. A phone draws at up to 3x density,
 * so a logo file at least twice this wide stays sharp, and Lighthouse's "image resolution" audit
 * (the file must be at least as large as the box it fills) passes without a bigger upload.
 */
export const LOGO_MAX_DISPLAY_WIDTH = 200

type LogoSize = { height?: null | number; width?: null | number }

/**
 * The `width` and `height` attributes for the header logo: the file's own shape, scaled down to
 * the cap and never up. They also reserve the box before the image arrives, so the logo cannot
 * shift the layout. A logo with no usable size gets none, and the browser uses the file's.
 */
export const logoDisplaySize = ({ height, width }: LogoSize): { height?: number; width?: number } => {
  if (!width || !height || width <= 0 || height <= 0) return {}
  if (width <= LOGO_MAX_DISPLAY_WIDTH) return { height, width }

  return {
    height: Math.max(1, Math.round((height * LOGO_MAX_DISPLAY_WIDTH) / width)),
    width: LOGO_MAX_DISPLAY_WIDTH,
  }
}
