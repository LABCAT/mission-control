import type { ServerProps } from 'payload'

import { adminCollectionPath } from './links'
import {
  activeTenantID,
  formatMinorUnits,
  jobBoardSlugs,
  loadSiteManagerDashboard,
  TENANT_COOKIE,
} from './dashboard'

/**
 * The site manager's dashboard (PJ-30, S-117).
 *
 * Rendered above Payload's own dashboard for a tenant manager: the jobs waiting for a
 * decision, the live and ended counts, and the newest orders, all for the tenant in the
 * multi-tenant selector. It renders nothing for anyone else, so a super admin's dashboard is
 * exactly as Payload ships it.
 *
 * Plain elements rather than Rocketship: this is Payload admin chrome inside the CMS, and the
 * admin's own stylesheets are what it has to match. Everything it needs from the domain comes
 * from `dashboard.ts`, so the same numbers can move to the Astro site later (Decision 3).
 */
export const SiteManagerDashboard = async ({ payload, server, user }: ServerProps) => {
  // `server` is only populated by the framework adapter, so the dashboard still renders for the
  // user's first tenant outside a request, e.g. in a script or a test.
  const cookies = server ? await server.getCookies() : null
  const tenantID = activeTenantID(user, cookies?.get(TENANT_COOKIE)?.value ?? null)
  if (tenantID === null || !user) return null

  const dashboard = await loadSiteManagerDashboard({
    payload,
    slugs: jobBoardSlugs(payload.config),
    tenantID,
    user,
  })
  const adminRoute = payload.config.routes.admin
  const jobPath = (id: number | string) => adminCollectionPath(adminRoute, dashboard.jobsSlug, id)
  const { tenant } = dashboard
  const money = (amountMinor: number) =>
    tenant.currency
      ? formatMinorUnits(amountMinor, {
          currency: tenant.currency,
          locale: tenant.locale,
          minorUnits: tenant.currencyMinorUnits,
        })
      : String(amountMinor)

  return (
    <section
      aria-label="Site dashboard"
      style={{ display: 'grid', gap: '1.5rem', marginBottom: '2rem' }}
    >
      <div>
        <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.25rem' }}>{tenant.name}</h1>
        <p style={{ margin: 0, opacity: 0.7 }}>Site dashboard</p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <Stat label="Pending jobs" value={dashboard.jobCounts.pending} />
        <Stat label="Live jobs" value={dashboard.jobCounts.live} />
        <Stat label="Ended jobs" value={dashboard.jobCounts.ended} />
        {dashboard.orders ? <Stat label="Orders" value={dashboard.orders.count} /> : null}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2rem' }}>
        <Panel title="Pending jobs" empty="No jobs are waiting for review.">
          {dashboard.pendingJobs.map((job) => (
            <li key={job.id}>
              <a href={jobPath(job.id)}>{job.title}</a>
              {job.organisation ? <span style={{ opacity: 0.7 }}> — {job.organisation}</span> : null}
            </li>
          ))}
        </Panel>

        {dashboard.orders ? (
          <Panel title="Recent orders" empty="No orders yet.">
            {dashboard.orders.recent.map((order) => (
              <li key={order.id}>
                <a href={adminCollectionPath(adminRoute, dashboard.orders?.slug ?? '', order.id)}>
                  #{order.id}
                </a>
                <span style={{ opacity: 0.7 }}>
                  {order.organisation ? ` — ${order.organisation}` : ''}
                  {order.status ? `, ${order.status}` : ''}
                </span>
                {order.currency ? <span> {money(order.totalMinor)}</span> : null}
              </li>
            ))}
          </Panel>
        ) : null}
      </div>
    </section>
  )
}

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div
    style={{
      border: '1px solid var(--theme-elevation-100)',
      borderRadius: '4px',
      flex: '1 1 8rem',
      padding: '0.75rem 1rem',
    }}
  >
    <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>{label}</div>
    <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{value}</div>
  </div>
)

const Panel = ({
  children,
  empty,
  title,
}: {
  children: React.ReactNode[]
  empty: string
  title: string
}) => (
  <div style={{ flex: '1 1 18rem' }}>
    <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>{title}</h2>
    {children.length === 0 ? (
      <p style={{ margin: 0, opacity: 0.7 }}>{empty}</p>
    ) : (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{children}</ul>
    )}
  </div>
)
