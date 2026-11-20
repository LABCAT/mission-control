import type { SiteTenant } from '@mission-control/launchpad'

/**
 * This site's own identity. Branding is the one thing a site app owns (PLAN.md: a new site is
 * "a new tenant row + a small `apps/<site>` — branding, domain, pages"). Currency, minor units,
 * timezone, locales, domains and the email sender come from the `vwok` tenant document in the
 * CMS and are never repeated here.
 *
 * The colours are the legacy site's palette. They reach the theme only as `--rs-*` tokens, via
 * the launchpad `BaseLayout`; nothing in this app restyles a Rocketship component.
 */
export const BRAND = {
  colorPrimary: '#06914b',
  colorAccent: '#dd3333',
  colorHover: '#0066bf',
} as const

/**
 * The logo from the legacy uploads
 * (`https://vanuatuwok.vu/app/uploads/2020/05/cropped-vanuatu-wok-logo.png`), resized to 400 px
 * wide. Width and height are the file's real size, so the header reserves the box before the
 * image arrives and the logo cannot shift the layout.
 */
export const LOGO = {
  alt: 'Vanuatu Wok',
  height: 86,
  src: '/brand/vanuatu-wok-logo.png',
  width: 400,
} as const

/** Hostnames that serve production content. Every other host is a preview and stays unindexed. */
export const PRODUCTION_HOSTNAMES: readonly string[] = ['vanuatuwok.vu', 'www.vanuatuwok.vu']

/** The tenant the theme renders. */
export const siteTenant: SiteTenant = {
  branding: {
    colorAccent: BRAND.colorAccent,
    colorHover: BRAND.colorHover,
    colorPrimary: BRAND.colorPrimary,
    logo: { alt: LOGO.alt, height: LOGO.height, url: LOGO.src, width: LOGO.width },
  },
  name: 'Vanuatu Wok',
  slug: 'vwok',
}
