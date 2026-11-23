/**
 * `/health` for the CMS (PJ-41): 200 when the Worker can reach the database, 503 when it cannot.
 * `no-store`, because a cached 200 would keep UptimeRobot green through an outage. The sites'
 * own `/health` calls this one.
 */
export const health = async (): Promise<Response> => {
  let ok = true
  try {
    const [{ getPayload }, { default: config }] = await Promise.all([
      import('payload'),
      import('./payload.config'),
    ])
    const payload = await getPayload({ config })
    await payload.db.pool?.query('select 1')
  } catch {
    ok = false
  }

  return new Response(JSON.stringify({ status: ok ? 'ok' : 'degraded' }), {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    status: ok ? 200 : 503,
  })
}
