import { escapeHtml, safeHref } from './lexical'

/**
 * The one responsive layout every tenant email sits in (PJ-50). A template supplies only a
 * subject and a body; the tenant supplies a logo, two colours and a footer. Table-based with
 * inline styles, because mail clients ignore most modern CSS; a small media query lets capable
 * clients use the full width on a phone.
 */

export type EmailBranding = {
  /** Page background behind the card. */
  backgroundColour?: null | string
  /** Header band and link accent. */
  brandColour?: null | string
  /** Footer, already rendered from the tenant's Lexical footer. */
  footerHtml?: string
  footerText?: string
  /** Absolute https URL of the logo. */
  logoUrl?: null | string
  /** Site name: the logo's alt text, and the header when there is no logo. */
  siteName?: null | string
}

export const DEFAULT_BRAND_COLOUR = '#1f4e79'
export const DEFAULT_BACKGROUND_COLOUR = '#f4f4f5'

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** A colour that is safe to put in a style attribute, or the fallback. */
export const safeColour = (value: null | string | undefined, fallback: string): string =>
  typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : fallback

/** Light text on a dark band, dark on a light one. */
const readableOn = (hex: string): string => {
  const full = hex.length === 4 ? `#${Array.from(hex.slice(1), (c) => c + c).join('')}` : hex
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]

  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111111' : '#ffffff'
}

const logoSrc = (url: null | string | undefined): null | string => {
  const href = safeHref(url)

  return href && /^https:/i.test(href) ? href : null
}

export const renderLayout = ({ bodyHtml, branding = {} }: { bodyHtml: string; branding?: EmailBranding }): string => {
  const brand = safeColour(branding.brandColour, DEFAULT_BRAND_COLOUR)
  const background = safeColour(branding.backgroundColour, DEFAULT_BACKGROUND_COLOUR)
  const onBrand = readableOn(brand)
  const siteName = escapeHtml(branding.siteName ?? '')
  const logo = logoSrc(branding.logoUrl)

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${siteName}" style="display:block;margin:0 auto;max-width:200px;max-height:60px;height:auto;border:0">`
    : `<span style="font-size:20px;font-weight:bold;color:${onBrand}">${siteName}</span>`
  const footer = branding.footerHtml
    ? `<tr><td class="px" style="padding:16px 24px;font-size:12px;line-height:18px;color:#666666;text-align:center">${branding.footerHtml}</td></tr>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<style>
a{color:${brand}}
@media only screen and (max-width:620px){.card{width:100%!important}.px{padding-left:16px!important;padding-right:16px!important}}
</style>
</head>
<body style="margin:0;padding:0;background:${background}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${background}">
<tr><td align="center" style="padding:24px 8px">
<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#222222">
<tr><td class="px" style="background:${brand};padding:16px 24px;text-align:center">${header}</td></tr>
<tr><td class="px" style="padding:24px">${bodyHtml}</td></tr>
${footer}
</table>
</td></tr>
</table>
</body>
</html>
`
}
