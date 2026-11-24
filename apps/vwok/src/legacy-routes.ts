/**
 * The legacy URL table for this site (PJ-42): the theme's rules plus this deployment's own data.
 *
 * Three things are site data rather than theme rules: the `?p=` shortlinks, the two pages the
 * founder chose to retire, and where the filter pages live. Keeping them here means the theme
 * stays generic and a second site only writes its own table.
 */
import { answerLegacy, type LegacyAnswer, type LegacyTarget } from '@mission-control/launchpad/redirects'

import { VWOK_SHORTLINKS } from './legacy-shortlinks'

/**
 * One-off answers a rule cannot express: an exact path that needs a different target, or a path
 * that moved twice. Empty for now, and the seam a future correction uses without a code change to
 * the theme.
 */
const VWOK_OVERRIDES: ReadonlyMap<string, LegacyTarget> = new Map()

export const vwokLegacyAnswer = (request: Pick<Request, 'method' | 'url'>): LegacyAnswer =>
  answerLegacy(request, { shortlinks: VWOK_SHORTLINKS, table: VWOK_OVERRIDES })
