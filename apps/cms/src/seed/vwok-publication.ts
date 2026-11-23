import type { PublicationSettings } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's publish and moderation rule: the legacy behaviour (query results, 19 Nov).
 * Moderation was off, an approved or invoice-able employer's job went live at once, and a new
 * employer's job waited for an admin. The founder's "trusted" switch (19 Nov) is what tells the
 * two employers apart, so: moderation never, trusted live on submit, others after approval, and
 * approving a job trusts its organisation.
 *
 * These are also the plugin's generic defaults, so a tenant row with nothing stored behaves the
 * same. Open question (STATUS 19 Nov): whether new employers should be reviewed under
 * `moderation: 'new-employers'` instead. That is a setting change, not a code change.
 */
export const vwokPublication: PublicationSettings = {
  moderation: 'never',
  newEmployerGoLive: 'after-approval',
  trustOnApproval: true,
  trustedGoLive: 'on-submit',
}
