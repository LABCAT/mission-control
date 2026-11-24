import type { AlertsReply, AlertSummary } from './client'

/**
 * What each alert page says (PJ-47), as plain data the Astro routes render. Keeping the words
 * here means the routes stay thin and the behaviour is testable without a browser.
 */

export type AlertNotice = {
  /** `info` for an expected outcome, `error` when the visitor can try again. */
  kind: 'error' | 'info' | 'success'
  message: string
  title: string
}

const failure = (reply: { code: string; message: string; ok: false }): AlertNotice => ({
  kind: 'error',
  message: reply.message,
  title: reply.code === 'invalid_token' ? 'This link is not valid' : 'We could not do that',
})

export const subscribeNotice = (
  reply: AlertsReply<{ status: 'pending' | 'subscribed' }>,
): AlertNotice => {
  if (!reply.ok) return failure(reply)

  return reply.status === 'subscribed'
    ? {
        kind: 'success',
        message: 'Your job alert is on. We will email you when new jobs match.',
        title: 'Job alert saved',
      }
    : {
        kind: 'success',
        message:
          'We have sent you an email. Open the link in it to start your job alert. If it does not arrive in a few minutes, check your spam folder.',
        title: 'Check your email',
      }
}

export const manageLinkNotice = (reply: AlertsReply<object>): AlertNotice =>
  reply.ok
    ? {
        kind: 'success',
        message:
          'If this address has job alerts, we have emailed it a link to manage them. The link works for 30 days.',
        title: 'Check your email',
      }
    : failure(reply)

export const confirmNotice = (reply: AlertsReply<{ alert: AlertSummary; manageToken?: string }>): AlertNotice =>
  reply.ok
    ? {
        kind: 'success',
        message: `Your job alert for ${reply.alert.summary} is on. We will email you ${reply.alert.frequency === 'weekly' ? 'once a week' : 'each day'} when there are new matching jobs.`,
        title: 'Job alert confirmed',
      }
    : failure(reply)

export const unsubscribeNotice = (reply: AlertsReply<{ already?: boolean }>): AlertNotice => {
  if (!reply.ok) return failure(reply)

  return reply.already
    ? {
        kind: 'info',
        message: 'This job alert was already switched off. You will not get any more emails from it.',
        title: 'Already unsubscribed',
      }
    : {
        kind: 'success',
        message: 'You will not get any more emails from this job alert. Your other alerts, if any, are not affected.',
        title: 'Unsubscribed',
      }
}

export const frequencyLabel = (frequency: AlertSummary['frequency']): string =>
  frequency === 'weekly' ? 'Weekly' : 'Daily'
