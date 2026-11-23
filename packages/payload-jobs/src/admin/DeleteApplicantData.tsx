import type { ServerProps } from 'payload'

import { isSuperAdmin, type MissionControlUser } from '../access'

/** The extra prop the plugin passes when it registers the component. */
export type DeleteApplicantDataProps = { applicationsSlug?: string }

/**
 * "Delete applicant data" on an application's edit view (PJ-88): the privacy request an
 * applicant makes by email. It is a plain HTML form posting to
 * `POST /api/applications/:id/delete-data`, so it ships no client JavaScript and the endpoint
 * re-checks the caller's own delete access.
 *
 * It renders nothing for a caller who may not delete the application, so the button is never a
 * dead end.
 */
export const DeleteApplicantData = async ({
  applicationsSlug = 'applications',
  id,
  payload,
  user,
}: ServerProps & DeleteApplicantDataProps) => {
  if (id === undefined) return null

  const actor = (user as MissionControlUser | null | undefined) ?? null
  const mayDelete =
    actor !== null &&
    (isSuperAdmin(actor) || (actor.tenants ?? []).some((membership) => membership?.role === 'tenant-admin'))
  if (!mayDelete) return null

  return (
    <form
      action={`${payload.config.routes.api}/${applicationsSlug}/${encodeURIComponent(String(id))}/delete-data`}
      method="post"
      style={{ marginBottom: '1rem' }}
    >
      <button
        style={{
          background: 'none',
          border: '1px solid currentColor',
          borderRadius: 4,
          cursor: 'pointer',
          padding: '0.4rem 0.75rem',
        }}
        type="submit"
      >
        Delete applicant data
      </button>
      <span style={{ marginLeft: '0.5rem', opacity: 0.7 }}>
        Removes this application and its CV files for good.
      </span>
    </form>
  )
}
