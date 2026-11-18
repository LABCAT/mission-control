/**
 * The legacy Vanuatu location picker: island keys, town values, transcribed from
 * `web/app/themes/efate/_dev/js/modules/regions-and-towns.js` on the `migration-plan` branch
 * of vanuatuwok.vu. The seed in `./vanuatu.ts` derives the location tree from this fixture,
 * and a test fails if the two drift apart.
 *
 * It is a fixture, not application code: nothing here runs at request time. Check the towns
 * against the legacy file before cutover — a missing town is a one-line change here.
 */

export const LEGACY_REGIONS_AND_TOWNS: Record<string, string[]> = {
  Ambae: ['Longana'],
  Efate: ['Forari', 'Port Vila'],
  Erromango: ['Ipota'],
  'Espiritu Santo': ['Butmas', 'Lorevilko', 'Luganville', 'Port Olry'],
  Gaua: ['Avire'],
  Malekula: ['Lakatoro', 'Lamap', 'Norsup'],
  Pentecost: ['Bunlap', 'Loltong'],
  Tanna: ['Ipikil', 'Isangel', 'Lenakel', 'Sulphur Bay', 'White Sands'],
  'Vanua Lava': ['Sola'],
  Overseas: ['Overseas'],
  Other: ['Other', 'Anywhere/Work From Home'],
}

/** Legacy keys that are catch-alls rather than places, kept as their own root. */
export const LEGACY_CATCH_ALL_REGIONS = ['Overseas', 'Other'] as const
