import { afterEach, describe, expect, it, vi } from 'vitest'

import { bootTestPayload } from './index'

describe('Postgres test harness database safety', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('does not fall back to the CMS database when TEST_DATABASE_URL is missing', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://orbit:orbit@localhost:8900/orbit')
    vi.stubEnv('TEST_DATABASE_URL', '')

    await expect(bootTestPayload({ collections: [] })).rejects.toThrow(
      'Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests',
    )
  })
})
