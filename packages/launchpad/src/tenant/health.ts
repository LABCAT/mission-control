/**
 * The `/health` answer UptimeRobot polls on every site and on the CMS (PJ-41, decision of 19 Nov).
 *
 * It must never be cached by anything: a cached 200 would keep reporting a healthy site after the
 * database stopped answering. So the response is `no-store`, and the checks are the ones that can
 * fail: the Worker itself (reaching this code), the CMS, and the database behind the CMS.
 */

export type HealthCheck = { ms: number; name: string; ok: boolean }

export type HealthReport = {
  checks: HealthCheck[]
  /** `degraded` when any check failed; the HTTP status carries the same answer. */
  status: 'degraded' | 'ok'
  /** The time the answer was built, so a stale cached copy is obvious if one ever appears. */
  time: string
}

export type HealthChecks = Record<string, () => Promise<unknown>>

/** Run every check, timing each one. A check that throws is a failure, not an error page. */
export const runHealthChecks = async (checks: HealthChecks): Promise<HealthCheck[]> =>
  Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      const started = Date.now()
      try {
        await check()
        return { ms: Date.now() - started, name, ok: true }
      } catch {
        return { ms: Date.now() - started, name, ok: false }
      }
    }),
  )

export const healthReport = async (checks: HealthChecks, now: Date = new Date()): Promise<HealthReport> => {
  const results = await runHealthChecks(checks)

  return {
    checks: results,
    status: results.every((check) => check.ok) ? 'ok' : 'degraded',
    time: now.toISOString(),
  }
}

/** 200 when every check passed, 503 when one failed, never cached. */
export const healthResponse = async (checks: HealthChecks): Promise<Response> => {
  const report = await healthReport(checks)

  return new Response(JSON.stringify(report), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
    status: report.status === 'ok' ? 200 : 503,
  })
}
