import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PUBLICATION_SETTINGS,
  PUBLICATION_MODERATION_MODES,
  PUBLICATION_TRIGGERS,
  decidePublication,
  needsReview,
  publicationDecisionFor,
  tenantPublicationSettings,
  triggerFor,
  type PublicationDecision,
  type PublicationModeration,
  type PublicationPayment,
  type PublicationSettings,
  type PublicationTrigger,
} from './publication'

const PAYMENTS: PublicationPayment[] = ['invoiced', 'none', 'paid']

// One row per case: [trusted, moderation, payment, go-live trigger, decision].
// "pending" = waits for a site manager or for the payment; both are the same status.
const TABLE: [boolean, PublicationModeration, PublicationPayment, PublicationTrigger, PublicationDecision][] = [
  // Vanuatu Wok's legacy rule: moderation never, trusted live on submit, new employer after approval.
  [true, 'never', 'invoiced', 'on-submit', 'published'],
  [true, 'never', 'paid', 'on-submit', 'published'],
  [true, 'never', 'none', 'on-submit', 'published'],
  [false, 'never', 'invoiced', 'after-approval', 'pending'],
  [false, 'never', 'paid', 'after-approval', 'pending'],
  [false, 'never', 'none', 'after-approval', 'pending'],
  // Live on submit, whoever the employer is, when moderation is off.
  [false, 'never', 'invoiced', 'on-submit', 'published'],
  // After payment: waits for the invoice, goes live once paid or when nothing is owed.
  [true, 'never', 'invoiced', 'after-payment', 'pending'],
  [true, 'never', 'paid', 'after-payment', 'published'],
  [true, 'never', 'none', 'after-payment', 'published'],
  [false, 'never', 'invoiced', 'after-payment', 'pending'],
  [false, 'never', 'paid', 'after-payment', 'published'],
  // Always review: every employer waits, whatever the trigger or payment.
  [true, 'always', 'paid', 'on-submit', 'pending'],
  [false, 'always', 'paid', 'on-submit', 'pending'],
  [true, 'always', 'paid', 'after-payment', 'pending'],
  [true, 'always', 'none', 'after-approval', 'pending'],
  // Review new employers only: a trusted employer skips the review, a new one waits.
  [true, 'new-employers', 'invoiced', 'on-submit', 'published'],
  [false, 'new-employers', 'invoiced', 'on-submit', 'pending'],
  [false, 'new-employers', 'paid', 'after-payment', 'pending'],
  [true, 'new-employers', 'paid', 'after-payment', 'published'],
  [true, 'new-employers', 'invoiced', 'after-payment', 'pending'],
]

const decide = (
  trusted: boolean,
  moderation: PublicationModeration,
  payment: PublicationPayment,
  goLive: PublicationTrigger,
  extra: { approved?: boolean; waitingForPurchase?: boolean } = {},
) =>
  decidePublication({
    approved: extra.approved ?? false,
    goLive,
    moderation,
    payment,
    trusted,
    waitingForPurchase: extra.waitingForPurchase ?? false,
  })

describe('publication rule: employer x moderation x payment x go-live @S-192', () => {
  it.each(TABLE)('trusted=%s moderation=%s payment=%s goLive=%s -> %s', (trusted, moderation, payment, goLive, expected) => {
    expect(decide(trusted, moderation, payment, goLive)).toBe(expected)
  })

  it('never publishes a job the review gate stops, in any combination', () => {
    for (const trusted of [true, false]) {
      for (const moderation of PUBLICATION_MODERATION_MODES) {
        for (const payment of PAYMENTS) {
          for (const goLive of PUBLICATION_TRIGGERS) {
            const decision = decide(trusted, moderation, payment, goLive)
            if (needsReview(moderation, trusted)) expect(decision).toBe('pending')
            if (goLive === 'after-approval') expect(decision).toBe('pending')
            if (goLive === 'after-payment' && payment === 'invoiced') expect(decision).toBe('pending')
          }
        }
      }
    }
  })

  it('publishes exactly when no gate holds the job', () => {
    for (const trusted of [true, false]) {
      for (const moderation of PUBLICATION_MODERATION_MODES) {
        for (const payment of PAYMENTS) {
          for (const goLive of PUBLICATION_TRIGGERS) {
            const held =
              needsReview(moderation, trusted) ||
              goLive === 'after-approval' ||
              (goLive === 'after-payment' && payment === 'invoiced')
            expect(decide(trusted, moderation, payment, goLive)).toBe(held ? 'pending' : 'published')
          }
        }
      }
    }
  })

  it('always publishes a job a site manager approved, whatever the gates say', () => {
    for (const moderation of PUBLICATION_MODERATION_MODES) {
      for (const payment of PAYMENTS) {
        for (const goLive of PUBLICATION_TRIGGERS) {
          expect(decide(false, moderation, payment, goLive, { approved: true })).toBe('published')
        }
      }
    }
  })

  it('holds a member’s purchase request for the owner, even for a trusted employer with moderation off', () => {
    expect(decide(true, 'never', 'none', 'on-submit', { waitingForPurchase: true })).toBe('waiting_for_purchase')
    expect(decide(false, 'always', 'paid', 'after-payment', { approved: true, waitingForPurchase: true })).toBe(
      'waiting_for_purchase',
    )
  })

  it('holds the job on a malformed setting instead of publishing it', () => {
    expect(decide(true, 'sometimes' as never, 'paid', 'on-submit')).toBe('pending')
    expect(decide(true, 'never', 'paid', 'whenever' as never)).toBe('pending')
  })
})

describe('publication settings per tenant @S-193', () => {
  const vwok: PublicationSettings = {
    moderation: 'never',
    newEmployerGoLive: 'after-approval',
    trustOnApproval: true,
    trustedGoLive: 'on-submit',
  }

  it('picks the trigger by whether the organisation is trusted', () => {
    const settings: PublicationSettings = { ...vwok, newEmployerGoLive: 'after-payment', trustedGoLive: 'on-submit' }
    expect(triggerFor(settings, true)).toBe('on-submit')
    expect(triggerFor(settings, false)).toBe('after-payment')
  })

  it('applies one tenant’s settings without touching another’s', () => {
    const strict: PublicationSettings = { ...vwok, moderation: 'always' }
    const args = { payment: 'paid' as const, trusted: true }
    expect(publicationDecisionFor({ ...args, settings: vwok })).toBe('published')
    expect(publicationDecisionFor({ ...args, settings: strict })).toBe('pending')
  })

  it('gives the generic defaults to a tenant that never set anything, which are the legacy vwok rule', () => {
    expect(tenantPublicationSettings(null)).toEqual(DEFAULT_PUBLICATION_SETTINGS)
    expect(tenantPublicationSettings({})).toEqual(DEFAULT_PUBLICATION_SETTINGS)
    expect(tenantPublicationSettings({ jobPublication: {} })).toEqual(DEFAULT_PUBLICATION_SETTINGS)
    expect(DEFAULT_PUBLICATION_SETTINGS).toEqual(vwok)
  })

  it('reads stored values, and turns trust-on-approval off only when it is explicitly false', () => {
    expect(
      tenantPublicationSettings({
        jobPublication: { moderation: 'always', newEmployerGoLive: 'after-payment', trustOnApproval: false, trustedGoLive: 'after-approval' },
      }),
    ).toEqual({
      moderation: 'always',
      newEmployerGoLive: 'after-payment',
      trustOnApproval: false,
      trustedGoLive: 'after-approval',
    })
    expect(tenantPublicationSettings({ jobPublication: { trustOnApproval: null } }).trustOnApproval).toBe(true)
  })

  it('passes a malformed stored value through, so the rule holds the job', () => {
    const settings = tenantPublicationSettings({ jobPublication: { moderation: 'weekly' } })
    expect(publicationDecisionFor({ payment: 'paid', settings, trusted: true })).toBe('pending')
  })
})
