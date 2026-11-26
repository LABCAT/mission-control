import { describe, expect, it } from 'vitest'

import { emailLogCollection } from './log'

describe('email log deliverability endpoint access @S-389', () => {
  const endpoint = emailLogCollection().endpoints
  const handler = Array.isArray(endpoint) ? endpoint.find((e) => e.path === '/deliverability')!.handler : undefined
  const call = async (user: unknown) =>
    (await handler!({ payload: {}, searchParams: new URLSearchParams(), user } as never)) as Response
  const member = (role: string) => ({ role: 'user', tenants: [{ role, tenant: 1 }] })

  it.each([
    ['employer', member('employer')],
    ['seeker', member('seeker')],
    ['anonymous', null],
  ])('denies %s with 403', async (_name, user) => {
    expect((await call(user)).status).toBe(403)
  })
})
