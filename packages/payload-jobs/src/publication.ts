/**
 * When a job goes live (PJ-32): one pure rule, read by checkout, the Approve action and the
 * "order paid" release. Nothing here writes; callers store the decision.
 *
 * Two gates decide, and a job publishes only when both have passed:
 *
 * 1. **Moderation** (`moderation`): every job waits for a site manager, only a new (untrusted)
 *    employer's job waits, or no job waits.
 * 2. **Go-live trigger** (`trustedGoLive` / `newEmployerGoLive`): the job is live on submit,
 *    after a site manager's approval, or after its order is settled (paid, free or by credit).
 *
 * The split keeps every legacy combination expressible: Vanuatu Wok ran with moderation off, an
 * approved employer's job live at once and a new employer's job waiting for an admin — which is
 * `moderation: 'never'`, `trustedGoLive: 'on-submit'`, `newEmployerGoLive: 'after-approval'`.
 *
 * A member's purchase request is not a publication decision at all: the order waits for its
 * owner (PJ-31), so the job waits too (`waiting_for_purchase`).
 */

/** What happens to a job's order before it can go live, as far as payment goes. */
export type PublicationPayment = 'invoiced' | 'none' | 'paid'

/** How many employers a review stops: all of them, only new ones, or none. */
export const PUBLICATION_MODERATION_MODES = ['always', 'new-employers', 'never'] as const
export type PublicationModeration = (typeof PUBLICATION_MODERATION_MODES)[number]

export const PUBLICATION_TRIGGERS = ['after-approval', 'after-payment', 'on-submit'] as const
export type PublicationTrigger = (typeof PUBLICATION_TRIGGERS)[number]

export const PUBLICATION_MODERATION_LABELS: Record<PublicationModeration, string> = {
  always: 'Review every job',
  'new-employers': 'Review only jobs from new employers',
  never: 'Never review jobs',
}

export const PUBLICATION_TRIGGER_LABELS: Record<PublicationTrigger, string> = {
  'after-approval': 'After a site manager approves it',
  'after-payment': 'After the order is paid',
  'on-submit': 'As soon as it is submitted',
}

export type PublicationSettings = {
  moderation: PublicationModeration
  newEmployerGoLive: PublicationTrigger
  /** Whether approving a job also marks its organisation as trusted. Default on. */
  trustOnApproval: boolean
  trustedGoLive: PublicationTrigger
}

/**
 * The generic default. A tenant that sets nothing publishes on submit: the least surprising
 * behaviour for a new site, and what a tenant without moderation means.
 */
export const DEFAULT_PUBLICATION_SETTINGS: PublicationSettings = {
  moderation: 'never',
  newEmployerGoLive: 'after-approval',
  trustOnApproval: true,
  trustedGoLive: 'on-submit',
}

export const isPublicationModeration = (value: unknown): value is PublicationModeration =>
  typeof value === 'string' && (PUBLICATION_MODERATION_MODES as readonly string[]).includes(value)

export const isPublicationTrigger = (value: unknown): value is PublicationTrigger =>
  typeof value === 'string' && (PUBLICATION_TRIGGERS as readonly string[]).includes(value)

export type PublicationDecision = 'pending' | 'published' | 'waiting_for_purchase'

export type PublicationInput = {
  /** A site manager has approved this job (the Approve action, or an earlier approval kept). */
  approved: boolean
  /** This employer's go-live trigger. See `triggerFor`. */
  goLive: PublicationTrigger
  moderation: PublicationModeration
  /** How the job's order stands: nothing owed, settled, or invoiced for later. */
  payment: PublicationPayment
  /** The organisation is trusted (the superseding 19 Nov decision), so `new-employers` skips it. */
  trusted: boolean
  /** The order waits for the organisation owner to approve the purchase (PJ-31). */
  waitingForPurchase: boolean
}

/** The trigger that applies to this employer: a trusted one may have its own. */
export const triggerFor = (settings: PublicationSettings, trusted: boolean): PublicationTrigger =>
  trusted ? settings.trustedGoLive : settings.newEmployerGoLive

/**
 * Does the review gate stop this employer's job? `moderation: 'new-employers'` is the legacy
 * behaviour, where the trust flag is what "new" means.
 */
export const needsReview = (moderation: PublicationModeration, trusted: boolean): boolean =>
  moderation === 'always' || (moderation === 'new-employers' && !trusted)

/**
 * Publish, hold for a site manager, or hold for the purchase.
 *
 * An approval always publishes the job: that is what the site manager decided, whatever the
 * gates would have said. An unknown moderation mode holds the job for review, the safe side of
 * a configuration error; an unknown trigger holds it too, rather than publishing something the
 * tenant meant to gate.
 */
export const decidePublication = ({
  approved,
  goLive,
  moderation,
  payment,
  trusted,
  waitingForPurchase,
}: PublicationInput): PublicationDecision => {
  if (waitingForPurchase) return 'waiting_for_purchase'
  if (approved) return 'published'

  const trigger = isPublicationTrigger(goLive) ? goLive : 'after-approval'
  const review = isPublicationModeration(moderation) ? needsReview(moderation, trusted) : true
  const unpaid = trigger === 'after-payment' && payment === 'invoiced'

  if (review || trigger === 'after-approval' || unpaid) return 'pending'
  return 'published'
}

/**
 * `decidePublication` for one employer and one tenant's settings. `trusted` only matters for
 * the `new-employers` moderation mode and for picking the go-live trigger.
 */
export const publicationDecisionFor = ({
  approved = false,
  payment,
  settings,
  trusted,
  waitingForPurchase = false,
}: {
  approved?: boolean
  payment: PublicationPayment
  settings: PublicationSettings
  trusted: boolean
  waitingForPurchase?: boolean
}): PublicationDecision =>
  decidePublication({
    approved,
    goLive: triggerFor(settings, trusted),
    moderation: settings.moderation,
    payment,
    trusted,
    waitingForPurchase,
  })

/** The tenant (or settings global) fields these settings live in. */
export type TenantPublicationSource = {
  jobPublication?: null | {
    moderation?: null | string
    newEmployerGoLive?: null | string
    trustOnApproval?: boolean | null
    trustedGoLive?: null | string
  }
}

/**
 * A tenant's publication settings. A tenant that never opened the group gets the generic
 * defaults; malformed stored values are passed through, so the rule holds the job rather than
 * guessing at what a broken setting meant.
 */
export const tenantPublicationSettings = (
  tenant: null | TenantPublicationSource | undefined,
): PublicationSettings => {
  const stored = tenant?.jobPublication
  if (!stored) return { ...DEFAULT_PUBLICATION_SETTINGS }

  return {
    moderation: (stored.moderation ?? DEFAULT_PUBLICATION_SETTINGS.moderation) as PublicationModeration,
    newEmployerGoLive: (stored.newEmployerGoLive ??
      DEFAULT_PUBLICATION_SETTINGS.newEmployerGoLive) as PublicationTrigger,
    trustOnApproval: stored.trustOnApproval !== false,
    trustedGoLive: (stored.trustedGoLive ?? DEFAULT_PUBLICATION_SETTINGS.trustedGoLive) as PublicationTrigger,
  }
}
