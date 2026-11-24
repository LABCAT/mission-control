'use client'

import { useEffect, useState } from 'react'

/** The application id from the admin URL, e.g. `/admin/collections/applications/12`. */
export const applicationIDFromPath = (pathname: string, applicationsSlug: string): null | string => {
  const escaped = applicationsSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`/collections/${escaped}/([^/?#]+)/?$`).exec(pathname)

  return match?.[1] && match[1] !== 'create' ? decodeURIComponent(match[1]) : null
}

type Membership = { role?: string; tenant?: { id?: number | string } | number | string | null }
type Me = { id: number | string; role?: string; tenants?: Membership[] | null }
type ApplicationRow = { tenant?: { id?: number | string } | number | string | null }

const idOf = (value: { id?: number | string } | number | string | null | undefined): null | string => {
  if (value === null || value === undefined) return null

  return String(typeof value === 'object' ? value.id : value)
}

/**
 * True when this user may delete the application: a super admin, or an admin of the
 * application's own tenant. The endpoint checks again, so this only hides a button that would
 * be refused.
 */
export const mayDeleteApplication = (me: Me | null | undefined, application: ApplicationRow): boolean => {
  if (!me) return false
  if (me.role === 'super-admin') return true

  const admins = (me.tenants ?? []).filter((membership) => membership?.role === 'tenant-admin')
  const tenant = idOf(application.tenant)
  // Single-tenant sites have no tenant on the row: any tenant admin may act.
  if (tenant === null) return admins.length > 0

  return admins.some((membership) => idOf(membership.tenant) === tenant)
}

/**
 * "Delete applicant data" on an application's edit view (PJ-88): the privacy request an
 * applicant makes by email.
 *
 * It must not be a form element: the admin renders `beforeDocumentControls` inside the document's
 * own form, and the application is read-only there, so a nested submit never leaves the page.
 * It is a button that confirms, then calls `POST /api/applications/:id/delete-data`, which
 * re-checks the caller's own delete access.
 */
export const DeleteApplicantData = ({ applicationsSlug = 'applications' }: { applicationsSlug?: string }) => {
  const [id, setId] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    const applicationID = applicationIDFromPath(window.location.pathname, applicationsSlug)
    if (!applicationID) return

    const load = async () => {
      const meResponse = await fetch('/api/users/me', { credentials: 'same-origin' })
      const me = ((await meResponse.json()) as { user?: Me }).user
      if (!me) return

      const response = await fetch(`/api/${applicationsSlug}/${encodeURIComponent(applicationID)}?depth=0`, {
        credentials: 'same-origin',
      })
      if (!response.ok) return

      if (mayDeleteApplication(me, (await response.json()) as ApplicationRow)) setId(applicationID)
    }

    load().catch(() => {})
  }, [applicationsSlug])

  if (!id) return null

  const remove = async () => {
    if (!window.confirm('Delete this application and its CV and cover letter for good? This cannot be undone.')) return

    setBusy(true)
    setError(null)

    try {
      const response = await fetch(`/api/${applicationsSlug}/${encodeURIComponent(id)}/delete-data?format=json`, {
        credentials: 'same-origin',
        method: 'POST',
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as null | { error?: string }
        setError(body?.error ?? 'Could not delete the applicant data.')

        return
      }

      window.location.assign(`${window.location.pathname.split('/collections/')[0]}/collections/${applicationsSlug}`)
    } catch {
      setError('Could not delete the applicant data.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
      <button
        className="btn btn--style-secondary btn--size-medium"
        data-testid="delete-applicant-data"
        disabled={busy}
        onClick={() => void remove()}
        style={{ cursor: 'pointer' }}
        type="button"
      >
        Delete applicant data
      </button>
      <span style={{ opacity: 0.7 }}>Removes this application and its CV files for good.</span>
      {error ? (
        <span role="alert" style={{ color: 'var(--theme-error-500)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
