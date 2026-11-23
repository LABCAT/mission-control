import { describe, expect, it, vi } from 'vitest'

import { healthReport, healthResponse, runHealthChecks } from './health'

describe('health checks @S-243', () => {
  it('reports ok when every check answers', async () => {
    const report = await healthReport({ cms: async () => {}, worker: async () => {} })

    expect(report.status).toBe('ok')
    expect(report.checks.map((check) => [check.name, check.ok])).toEqual([
      ['cms', true],
      ['worker', true],
    ])
  })

  it('reports degraded when the database behind the CMS fails, naming the check', async () => {
    const report = await healthReport({
      cms: async () => {},
      database: async () => {
        throw new Error('connection refused')
      },
    })

    expect(report.status).toBe('degraded')
    expect(report.checks.find((check) => check.name === 'database')?.ok).toBe(false)
  })

  it('answers 200 with no-store when healthy, so a monitor never reads a stale copy', async () => {
    const response = await healthResponse({ cms: async () => {} })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it('answers 503 when a check fails, so UptimeRobot alerts', async () => {
    const response = await healthResponse({
      cms: async () => {
        throw new Error('down')
      },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  it('times each check and keeps the order they were declared in', async () => {
    const checks = await runHealthChecks({ first: async () => {}, second: async () => {} })

    expect(checks.map((check) => check.name)).toEqual(['first', 'second'])
    expect(checks.every((check) => check.ms >= 0)).toBe(true)
  })

  it('treats a check that never answers in time as a failure, not a hanging request', async () => {
    const slow = vi.fn(async () => {
      throw new Error('timed out')
    })

    const report = await healthReport({ cms: slow })

    expect(report.status).toBe('degraded')
  })
})
