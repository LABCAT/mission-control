/**
 * The legacy `?p=ID` shortlinks, as the crawl recorded them
 * (`docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md` §8).
 *
 * A shortlink is per-post data, not a rule, so it lives beside the site rather than in the theme's
 * redirect engine. Each target is the post's final new URL, never another legacy URL, and the
 * test checks that by resolving every target again: a target that is itself legacy would be a
 * chain, which the brief forbids.
 *
 * The crawl found 50 shortlinks. Four are not listed here, so they answer 410 instead:
 *
 * - `?p=168` (`job-email-text`), `?p=791` (`no-resumes`), `?p=29143` (`organisation-competition`)
 *   and `?p=33579` (`land-law-reforms`) name pages the new site does not carry over;
 * - the CV profile, which goes with the rest of `/resumes/*` (a seeker's personal data is not
 *   carried over, PJ-89).
 *
 * An id that is not in this table answers 410: it is a post the new site did not keep. That is
 * why `/home-2` and `/sample-page` are listed even though they resolve to `/` by rule — omitting
 * an id means "gone", not "figure it out".
 */
export const VWOK_SHORTLINKS: ReadonlyMap<number, string> = new Map([
  [2, '/'],
  [5, '/'],
  [9, '/jobs'],
  [10, '/terms-conditions'],
  [16, '/account/login'],
  [17, '/account/register'],
  [18, '/account'],
  [38, '/employers'],
  [61, '/volunteer-jobs'],
  [70, '/account'],
  [206, '/account/register'],
  [655, '/contact'],
  [3983, '/about'],
  [23445, '/organisations'],
  [29301, '/contact'],
  [73891, '/'],
  [140040, '/jobs/experienced-chef-bar-kitchen-reception-office'],
  [141332, '/jobs/mason%ef%bc%88bricklayer-brickmason%ef%bc%89'],
  [141435, '/jobs/experienced-resort-staff'],
  [141471, '/jobs/vendeur-preparateur-livreur-6'],
  [141516, '/jobs/logistics-assistant-2'],
  [141525, '/jobs/trainee'],
  [141550, '/jobs/skills-adviser-vanuatu-multiple-positions'],
  [141564, '/jobs/provision-of-dwssp-training-and-reporting-for-tafea-province'],
  [141568, '/jobs/provision-of-dwssp-training-and-reporting-for-sanma-province'],
  [141575, '/jobs/senior-analyst-parts-supervisor-5'],
  [141584, '/jobs/mechanic-10'],
  [
    141597,
    '/jobs/provision-of-technical-assessment-design-and-cost-estimation-of-five-earthquake-affected-community-water-supply-systems-in-efate-vanuatu',
  ],
  [
    141601,
    '/jobs/labour-construction-works-only-for-three-3-rainwater-harvesting-systems-on-paama-island-at-the-following-sites-liro-tevali-tevaliaot',
  ],
  [141609, '/jobs/disaster-ready-project-manager-3'],
  [141615, '/jobs/request-for-expressions-of-interest-reoi-change-management-specialist-pecialist'],
  [
    141635,
    '/jobs/request-for-quotation-development-of-a-revised-vanuatu-national-ngo-policy-towards-a-strategic-partnership-framework-for-localised-development-2026-2020',
  ],
  [141638, '/jobs/housekeeping-supervisor-3'],
  [141639, '/jobs/welder-2'],
  [141651, '/jobs/administration-manager-4'],
  [141660, '/jobs/senior-lecturer-in-accounting'],
  [141663, '/jobs/lecturer-in-accounting'],
  [141675, '/jobs/teachers-2'],
  [141683, '/jobs/readvertised-request-for-expressions-of-interest-reoi-real-estate-agent-firm'],
  [
    141688,
    '/jobs/readvertised-request-for-expressions-of-interest-reoi-esmasp-conveyancing-lawyer',
  ],
  [141698, '/jobs/request-for-quotation-expert-concultant-to-develop-an-important-substitution-srategy'],
  [141704, '/jobs/executive-chef-16'],
  [141709, '/jobs/enumerator'],
  [141716, '/jobs/job-vacancy-junior-photocopier-technician'],
])
