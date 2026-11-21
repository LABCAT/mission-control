'use client'

import { useEffect, useState } from 'react'

type Report = { fields: { default?: boolean; key: string; label: string }[]; key: string; label: string }

/**
 * Site manager reports page (/admin/reports): choose a report, a date range and the fields,
 * then download the CSV. All the work happens in the `/api/reports` endpoints.
 */
export const ReportsView = () => {
  const [reports, setReports] = useState<Report[] | null>(null)
  const [error, setError] = useState<string>()
  const [key, setKey] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [fields, setFields] = useState<string[]>([])

  // A super admin picks the tenant in the admin; the endpoint reads it from the query string.
  const tenant = typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('tenant') ?? '')
  const tenantQuery = tenant ? `tenant=${encodeURIComponent(tenant)}` : ''

  useEffect(() => {
    fetch(`/api/reports${tenantQuery ? `?${tenantQuery}` : ''}`, { credentials: 'include' })
      .then(async (response) => {
        if (response.status === 404) return setReports([])
        const body = (await response.json()) as { error?: string; reports?: Report[] }
        if (!response.ok) return setError(body.error ?? 'Could not load reports.')
        setReports(body.reports ?? [])
        const first = body.reports?.[0]
        if (first) {
          setKey(first.key)
          setFields(first.fields.filter((field) => field.default === true).map((field) => field.key))
        }
      })
      .catch(() => setError('Could not load reports.'))
  }, [tenantQuery])

  const report = reports?.find((entry) => entry.key === key)
  const params = new URLSearchParams(tenantQuery)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  params.set('fields', fields.join(','))

  const choose = (next: string) => {
    setKey(next)
    setFields(
      reports?.find((entry) => entry.key === next)?.fields.filter((field) => field.default === true).map((field) => field.key) ?? [],
    )
  }

  return (
    <div style={{ margin: '2rem auto', maxWidth: '40rem', padding: '0 1rem' }}>
      <h1>Reports</h1>
      {error ? <p role="alert">{error}</p> : null}
      {reports === null ? <p>Loading…</p> : null}
      {reports?.length === 0 ? <p>No reports are available for this site.</p> : null}
      {report ? (
        <form onSubmit={(event) => event.preventDefault()}>
          <p>
            <label>
              Report{' '}
              <select onChange={(event) => choose(event.target.value)} value={key}>
                {reports?.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              From <input onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
            </label>{' '}
            <label>
              To <input onChange={(event) => setTo(event.target.value)} type="date" value={to} />
            </label>
          </p>
          <fieldset>
            <legend>Fields</legend>
            {report.fields.map((field) => (
              <label key={field.key} style={{ display: 'block' }}>
                <input
                  checked={fields.includes(field.key)}
                  onChange={(event) =>
                    setFields((current) =>
                      event.target.checked ? [...current, field.key] : current.filter((entry) => entry !== field.key),
                    )
                  }
                  type="checkbox"
                />{' '}
                {field.label}
              </label>
            ))}
          </fieldset>
          <p>
            {fields.length === 0 ? (
              <span>Tick at least one field.</span>
            ) : (
              <a download href={`/api/reports/${encodeURIComponent(report.key)}/csv?${params.toString()}`}>
                Download CSV
              </a>
            )}
          </p>
        </form>
      ) : null}
    </div>
  )
}
