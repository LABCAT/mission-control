import type { TenantBranding } from './types'

/**
 * Tenant branding is applied only through Rocketship's `--rs-*` custom properties. The theme
 * never restyles a Rocketship component, so a tenant changes the palette and nothing else.
 *
 * | tenant branding | Rocketship token                                     |
 * | --------------- | ---------------------------------------------------- |
 * | colorPrimary    | `--rs-color-accent`, `--rs-color-link`               |
 * | colorHover      | `--rs-color-accent-hover`, `--rs-color-link-hover`   |
 * | colorAccent     | `--rs-color-focus-ring`                              |
 * | (derived)       | `--rs-color-accent-contrast`, readable on the primary |
 */
export type BrandingTokens = Record<`--rs-color-${string}`, string>

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** Expands a 3-digit hex colour and lowercases it, or returns undefined for anything else. */
export const normaliseHex = (value: null | string | undefined): string | undefined => {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!HEX.test(trimmed)) return undefined
  if (trimmed.length === 7) return trimmed.toLowerCase()
  const [r, g, b] = trimmed.slice(1).split('')
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
}

const channelLuminance = (channel: string): number => {
  const srgb = Number.parseInt(channel, 16) / 255
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a normalised 6-digit hex colour. */
export const relativeLuminance = (hex: string): number => {
  const value = normaliseHex(hex)
  if (!value) throw new TypeError(`Not a hex colour: ${hex}`)
  return (
    0.2126 * channelLuminance(value.slice(1, 3)) +
    0.7152 * channelLuminance(value.slice(3, 5)) +
    0.0722 * channelLuminance(value.slice(5, 7))
  )
}

/**
 * Picks black or white for text on the given colour. The threshold is where both choices
 * have the same WCAG contrast ratio (luminance 0.179), so the result is the better one.
 */
export const readableOn = (hex: string): string =>
  relativeLuminance(hex) > 0.179 ? '#000000' : '#ffffff'

export const brandingTokens = (branding?: null | TenantBranding): BrandingTokens => {
  const tokens: BrandingTokens = {}

  const primary = normaliseHex(branding?.colorPrimary)
  const hover = normaliseHex(branding?.colorHover)
  const accent = normaliseHex(branding?.colorAccent)

  if (primary) {
    tokens['--rs-color-accent'] = primary
    tokens['--rs-color-link'] = primary
    tokens['--rs-color-accent-contrast'] = readableOn(primary)
  }

  if (hover) {
    tokens['--rs-color-accent-hover'] = hover
    tokens['--rs-color-link-hover'] = hover
  }

  if (accent) {
    tokens['--rs-color-focus-ring'] = accent
  }

  // Sorted so the generated CSS is byte-for-byte stable for a given tenant.
  return Object.fromEntries(
    Object.entries(tokens).toSorted(([left], [right]) => left.localeCompare(right)),
  ) as BrandingTokens
}

/** The branding as a stylesheet, for a `<style>` tag. Empty when the tenant has no branding. */
export const brandingStyle = (branding?: null | TenantBranding, selector = ':root'): string => {
  const declarations = Object.entries(brandingTokens(branding)).map(
    ([property, value]) => `${property}: ${value}`,
  )

  return declarations.length === 0 ? '' : `${selector} { ${declarations.join('; ')}; }`
}

/**
 * The branding as a `style` attribute on `<html>`. Custom properties inherit, so one
 * attribute themes the whole document without a `<style>` tag built from tenant data.
 */
export const brandingStyleAttribute = (branding?: null | TenantBranding): string | undefined => {
  const declarations = Object.entries(brandingTokens(branding)).map(
    ([property, value]) => `${property}: ${value}`,
  )

  return declarations.length === 0 ? undefined : declarations.join('; ')
}
