'use client'

import { useState } from 'react'

import type { AnalyticsLoadResult, AnalyticsRange, CloudflareAnalyticsData } from '../types'

type Props = {
  endpoint: string
  initialError?: string
  initialRange: AnalyticsRange
  initialResult: AnalyticsLoadResult
}

const number = (value: number): string => value.toLocaleString('en')

const Totals = ({ data }: { data: CloudflareAnalyticsData }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '1rem' }}>
    <div>
      <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>Visits</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{number(data.visits)}</div>
    </div>
    <div>
      <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>Page views</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{number(data.pageViews)}</div>
    </div>
  </div>
)

const List = ({
  empty,
  rows,
  title,
}: {
  empty: string
  rows: { label: string; views: number }[]
  title: string
}) => (
  <div style={{ minWidth: '14rem', flex: '1 1 14rem' }}>
    <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>{title}</h3>
    {rows.length === 0 ? (
      <p style={{ margin: 0, opacity: 0.7 }}>{empty}</p>
    ) : (
      <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
        {rows.map((row) => (
          <li key={row.label}>
            <span style={{ wordBreak: 'break-all' }}>{row.label}</span> — {number(row.views)}
          </li>
        ))}
      </ol>
    )}
  </div>
)

const DataView = ({ data }: { data: CloudflareAnalyticsData }) => (
  <div>
    <Totals data={data} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2rem', marginBottom: '1rem' }}>
      <List
        empty="No page views yet."
        rows={data.topPages.map((page) => ({ label: page.path, views: page.views }))}
        title="Top pages"
      />
      <List
        empty="No referrers yet."
        rows={data.topReferrers.map((referrer) => ({ label: referrer.host, views: referrer.views }))}
        title="Top referrers"
      />
    </div>
    <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>Daily</h3>
    {data.daily.length === 0 ? (
      <p style={{ margin: 0, opacity: 0.7 }}>No traffic in this range.</p>
    ) : (
      <ul style={{ columns: '2 12rem', margin: 0, paddingLeft: '1.25rem' }}>
        {data.daily.map((day) => (
          <li key={day.date}>
            {day.date}: {number(day.pageViews)} views, {number(day.visits)} visits
          </li>
        ))}
      </ul>
    )}
  </div>
)

/**
 * Client side of the dashboard. The server component passes the first result; changing the
 * range reads the signed-in endpoint so the server-side cache is reused.
 */
export const AnalyticsPanel = ({ endpoint, initialError, initialRange, initialResult }: Props) => {
  const [range, setRange] = useState<AnalyticsRange>(initialRange)
  const [result, setResult] = useState<AnalyticsLoadResult>(initialResult)
  const [error, setError] = useState<string | undefined>(initialError)
  const [loading, setLoading] = useState(false)

  const load = async (nextRange: AnalyticsRange) => {
    if (nextRange === range && !error) return
    setRange(nextRange)
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(`${endpoint}?range=${nextRange}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const body = (await response.json()) as {
        configured?: boolean
        data?: CloudflareAnalyticsData
      }
      if (!response.ok) throw new Error('analytics request failed')
      setResult(
        body.configured && body.data ? { configured: true, data: body.data } : { configured: false },
      )
    } catch {
      setError('Could not load Cloudflare analytics.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div aria-label="Date range" role="group" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {([7, 30] as const).map((days) => (
          <button
            aria-pressed={range === days}
            disabled={loading}
            key={days}
            onClick={() => void load(days)}
            style={{
              background: range === days ? 'var(--theme-elevation-150)' : 'transparent',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              cursor: 'pointer',
              padding: '0.3rem 0.6rem',
            }}
            type="button"
          >
            {days} days
          </button>
        ))}
        {loading ? <span style={{ alignSelf: 'center', opacity: 0.7 }}>Loading…</span> : null}
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : result.configured ? (
        <DataView data={result.data} />
      ) : (
        <p style={{ margin: 0 }}>
          Cloudflare Analytics is not set up for this site yet. Add a Web Analytics site tag to
          start collecting traffic.
        </p>
      )}
    </div>
  )
}
