'use client'

import { useEffect, useState } from 'react'

type Membership = { role?: string; tenant?: { id: number | string; name?: string; slug?: string } | number | string }

type TenantChoice = { label: string; slug: string }

const ACCOUNT_ROLES = ['seeker', 'employer']

// Must match VIEW_AS_CSRF_HEADER / VIEW_AS_CSRF_VALUE in ../view-as.ts. Not imported: this file
// ships to the browser and must not pull the server module (and `payload`) in with it.
const CSRF_HEADER = 'x-mc-view-as'

/** The user id from the admin URL, e.g. `/admin/collections/users/12`. */
export const userIDFromPath = (pathname: string): null | string => {
  const match = /\/collections\/users\/([^/?#]+)\/?$/.exec(pathname)

  return match?.[1] && match[1] !== 'create' ? decodeURIComponent(match[1]) : null
}

/** The tenants this user could be viewed on: their site accounts, if they are not staff anywhere. */
export const viewAsChoices = (user: { role?: string; tenants?: Membership[] | null }): TenantChoice[] => {
  if (user.role !== 'user') return []

  const memberships = user.tenants ?? []
  if (memberships.some((membership) => membership.role && !ACCOUNT_ROLES.includes(membership.role))) return []

  return memberships.flatMap((membership): TenantChoice[] => {
    const tenant = membership.tenant
    if (!membership.role || !ACCOUNT_ROLES.includes(membership.role)) return []
    if (!tenant || typeof tenant !== 'object' || !tenant.slug) return []

    return [{ label: tenant.name ?? tenant.slug, slug: tenant.slug }]
  })
}

/** Posts the one-time code to the tenant site in a new tab. A form POST, so the code is never in a URL. */
const openSite = (startURL: string, code: string) => {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = startURL
  form.target = '_blank'
  form.style.display = 'none'

  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'code'
  input.value = code
  form.appendChild(input)

  document.body.appendChild(form)
  form.submit()
  form.remove()
}

/**
 * "View as this user" (PJ-119, S-073) on the admin user screen. Only super admins see it, and
 * only for a user the server would accept (a site account). The server enforces all of it again:
 * this just hides buttons that would be refused.
 */
export const ViewAsUserButton = () => {
  const [choices, setChoices] = useState<TenantChoice[]>([])
  const [error, setError] = useState<null | string>(null)
  const [id, setId] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const userID = userIDFromPath(window.location.pathname)
    if (!userID) return

    const load = async () => {
      const me = (await (await fetch('/api/users/me', { credentials: 'same-origin' })).json()) as {
        user?: { id: number | string; role?: string }
      }
      if (me.user?.role !== 'super-admin' || String(me.user.id) === userID) return

      const response = await fetch(`/api/users/${encodeURIComponent(userID)}?depth=1`, {
        credentials: 'same-origin',
      })
      if (!response.ok) return

      setId(userID)
      setChoices(viewAsChoices((await response.json()) as never))
    }

    load().catch(() => {})
  }, [])

  if (!id || choices.length === 0) return null

  const start = async (slug: string) => {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch(`/api/users/${encodeURIComponent(id)}/view-as`, {
        body: JSON.stringify({ tenant: slug }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: 'start' },
        method: 'POST',
      })
      const body = (await response.json()) as { code?: string; error?: { message?: string }; startURL?: string }

      if (!response.ok || !body.code || !body.startURL) {
        setError(body.error?.message ?? 'Could not start viewing as this user.')

        return
      }

      openSite(body.startURL, body.code)
    } catch {
      setError('Could not start viewing as this user.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      {choices.map((choice) => (
        <button
          className="btn btn--style-secondary btn--size-medium"
          disabled={busy}
          key={choice.slug}
          onClick={() => void start(choice.slug)}
          style={{ cursor: 'pointer' }}
          title="Opens the site as this user for 30 minutes. It is logged."
          type="button"
        >
          View as this user{choices.length > 1 ? ` on ${choice.label}` : ''}
        </button>
      ))}
      {error ? (
        <span role="alert" style={{ color: 'var(--theme-error-500)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
