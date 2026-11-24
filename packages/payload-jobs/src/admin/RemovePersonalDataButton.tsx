'use client'

import { useEffect, useState } from 'react'

// Must match REMOVE_PERSONAL_DATA_CSRF_HEADER / VALUE in ../anonymise-user.ts. Not imported:
// this file ships to the browser and must not pull the server module (and `payload`) in.
const CSRF_HEADER = 'x-mc-remove-personal-data'

/** The user id from the admin URL, e.g. `/admin/collections/users/12`. */
export const userIDFromPath = (pathname: string): null | string => {
  const match = /\/collections\/users\/([^/?#]+)\/?$/.exec(pathname)

  return match?.[1] && match[1] !== 'create' ? decodeURIComponent(match[1]) : null
}

type Me = { user?: { id: number | string; role?: string } }
type Target = { email?: string; id: number | string; role?: string; tenants?: unknown[] | null }

/** True when the current user may act on this one: not themselves, not a super admin they are not. */
export const mayRemove = (me: Me['user'], target: Target): boolean => {
  if (!me || String(me.id) === String(target.id)) return false
  if (me.role === 'super-admin') return true
  if (target.role === 'super-admin') return false

  return (target.tenants ?? []).length > 0
}

/**
 * "Remove personal data" (PJ-89, S-311) on the admin user screen. The person keeps their id, so
 * orders and invoices still point at them; the name, email, phone, applications, CVs and alert
 * subscriptions go. The server checks permission and the CSRF header again, so this only hides
 * a button that would be refused.
 */
export const RemovePersonalDataButton = () => {
  const [error, setError] = useState<null | string>(null)
  const [done, setDone] = useState<null | string>(null)
  const [id, setId] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const userID = userIDFromPath(window.location.pathname)
    if (!userID) return

    const load = async () => {
      const me = (await (await fetch('/api/users/me', { credentials: 'same-origin' })).json()) as Me
      if (!me.user || String(me.user.id) === userID) return

      const response = await fetch(`/api/users/${encodeURIComponent(userID)}?depth=0`, {
        credentials: 'same-origin',
      })
      if (!response.ok) return

      if (mayRemove(me.user, (await response.json()) as Target)) setId(userID)
    }

    load().catch(() => {})
  }, [])

  if (!id) return null

  const remove = async () => {
    if (!window.confirm('Remove this person’s name, contact details, applications and alert subscriptions? Orders and invoices stay.')) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const response = await fetch(`/api/users/${encodeURIComponent(id)}/remove-personal-data`, {
        body: JSON.stringify({ reason: 'Requested by the person, removed in the admin' }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: 'confirm' },
        method: 'POST',
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as null | { error?: { message?: string } }
        setError(body?.error?.message ?? 'Could not remove the personal data.')

        return
      }

      setDone('Personal data removed. Orders and invoices still point at this user.')

      // Reload so the form shows the anonymised values.
      window.location.reload()
    } catch {
      setError('Could not remove the personal data.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <button
        className="btn btn--style-secondary btn--size-medium"
        disabled={busy}
        onClick={() => void remove()}
        style={{ cursor: 'pointer' }}
        title="Removes name, contact details, applications and alert subscriptions. Orders and invoices stay."
        type="button"
      >
        Remove personal data
      </button>
      {done ? <span role="status">{done}</span> : null}
      {error ? (
        <span role="alert" style={{ color: 'var(--theme-error-500)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
