'use client'

import { useEffect, useState } from 'react'

type Membership = { role?: string; tenant?: { id: number | string } | number | string }
type Me = { id?: number | string; role?: string; tenants?: Membership[] | null }
type Job = { status?: string; tenant?: { id: number | string } | number | string | null }

// Roles that may approve, as in JOB_STAFF_ROLES (./collections/jobs). Not imported: this file
// ships to the browser and must not pull the server module (and `payload`) in with it.
const STAFF_ROLES = ['tenant-admin', 'editor']

/** The collection slug and job id from the admin URL, e.g. `/admin/collections/jobs/12`. */
export const jobFromPath = (pathname: string): null | { id: string; slug: string } => {
  const match = /\/collections\/([^/]+)\/([^/?#]+)\/?$/.exec(pathname)
  if (!match?.[1] || !match[2] || match[2] === 'create') return null

  return { id: decodeURIComponent(match[2]), slug: decodeURIComponent(match[1]) }
}

const idOf = (value: unknown): null | string => {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (value && typeof value === 'object' && 'id' in value) return idOf((value as { id: unknown }).id)
  return null
}

/**
 * Whether to show Approve: the job is waiting for approval and the user is a super admin or a
 * site manager of the job's tenant. The server enforces it again; this hides a button it would refuse.
 */
export const canShowApprove = (me: Me | null | undefined, job: Job | null | undefined): boolean => {
  if (!me || !job || job.status !== 'pending') return false
  if (me.role === 'super-admin') return true

  const tenant = idOf(job.tenant)
  if (tenant === null) return false

  return (me.tenants ?? []).some(
    (membership) =>
      membership.role !== undefined && STAFF_ROLES.includes(membership.role) && idOf(membership.tenant) === tenant,
  )
}

/**
 * "Approve" on the admin job screen (PJ-32, S-194): publishes a pending job and, when the site's
 * setting says so, marks its organisation as trusted. The rule lives behind
 * `POST /api/<jobs>/:id/approve`, so the Astro /manage area can call the same thing later.
 */
export const ApproveJobButton = () => {
  const [target, setTarget] = useState<null | { id: string; slug: string }>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    const found = jobFromPath(window.location.pathname)
    if (!found) return

    const load = async () => {
      const me = (await (await fetch('/api/users/me', { credentials: 'same-origin' })).json()) as { user?: Me }
      const response = await fetch(`/api/${encodeURIComponent(found.slug)}/${encodeURIComponent(found.id)}?depth=0`, {
        credentials: 'same-origin',
      })
      if (!response.ok) return

      if (canShowApprove(me.user, (await response.json()) as Job)) setTarget(found)
    }

    load().catch(() => {})
  }, [])

  if (!target) return null

  const approve = async () => {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch(`/api/${encodeURIComponent(target.slug)}/${encodeURIComponent(target.id)}/approve`, {
        credentials: 'same-origin',
        method: 'POST',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
        setError(body.error?.message ?? 'Could not approve this job.')

        return
      }

      window.location.reload()
    } catch {
      setError('Could not approve this job.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <button
        className="btn btn--style-primary btn--size-medium"
        disabled={busy}
        onClick={() => void approve()}
        style={{ cursor: 'pointer' }}
        title="Publishes this job. It is logged in the job's history."
        type="button"
      >
        Approve and publish
      </button>
      {error ? (
        <span role="alert" style={{ color: 'var(--theme-error-500)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
