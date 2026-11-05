import type { GlobalConfig } from 'payload'

/** Written by scheduled tasks so it's easy to see the cron is alive. Read-only in the admin. */
export const SystemStatus: GlobalConfig = {
  slug: 'system-status',
  admin: { group: 'System' },
  versions: false,
  access: {
    read: ({ req }) => Boolean(req.user),
    update: () => false,
  },
  fields: [
    { name: 'lastHeartbeatAt', type: 'date', admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'lastCron', type: 'text', admin: { readOnly: true } },
  ],
}
