import { describe, expect, it } from 'vitest'

import {
  formatOffboardingReport,
  OFFBOARDING_USAGE,
  offboardingStoppedMessage,
  parseOffboardingArgs,
} from './tenant-offboarding-cli'

const failure = (argv: string[]): string => {
  try {
    parseOffboardingArgs(argv)
  } catch (error) {
    return (error as Error).message
  }

  throw new Error('expected the arguments to be refused')
}

describe('parseOffboardingArgs @S-271', () => {
  it('needs a tenant and defaults to a non-destructive run', () => {
    expect(parseOffboardingArgs(['--tenant', 'vwok'])).toEqual({
      deleteTenant: false,
      dryRun: false,
      exportPath: null,
      keep: [],
      tenant: 'vwok',
    })
  })

  it('takes a dry run, an export path, extra keeps and the tenant delete', () => {
    expect(
      parseOffboardingArgs([
        '--tenant',
        '7',
        '--export',
        'vwok.json',
        '--keep',
        'xero-invoices',
        '--keep',
        'xero-settings',
        '--delete-tenant',
      ]),
    ).toEqual({
      deleteTenant: true,
      dryRun: false,
      exportPath: 'vwok.json',
      keep: ['xero-invoices', 'xero-settings'],
      tenant: '7',
    })
  })

  it('refuses a missing tenant, an unknown flag, a value-less flag and a contradiction', () => {
    expect(failure([])).toContain('--tenant is required')
    expect(failure(['--tenant'])).toContain('--tenant needs a value')
    expect(failure(['--tenant', 'vwok', '--explode'])).toContain('Unknown argument "--explode"')
    expect(failure(['--tenant', 'vwok', '--dry-run', '--delete-tenant'])).toContain(
      'contradict each other',
    )
    expect(failure(['--help'])).toBe(OFFBOARDING_USAGE)
  })
})

describe('formatOffboardingReport @S-271', () => {
  it('names what goes, what is kept and what refused', () => {
    const lines = formatOffboardingReport({
      errors: [{ message: 'still referenced', slug: 'jobs' }],
      kept: [{ docs: 2, slug: 'orders' }],
      removed: [{ docs: 3, slug: 'jobs' }, { docs: 1, slug: 'plans' }],
      tenant: 'vwok',
    })

    expect(lines).toEqual([
      'Tenant vwok:',
      '  removed (or would remove): 3 jobs, 1 plans',
      '  kept: 2 orders',
      '  refused: jobs: still referenced',
    ])
  })

  it('says nothing rather than an empty list', () => {
    expect(
      formatOffboardingReport({ errors: [], kept: [], removed: [], tenant: 7 }),
    ).toEqual(['Tenant 7:', '  removed (or would remove): nothing', '  kept: nothing'])
  })
})

describe('offboardingStoppedMessage @S-271', () => {
  const refused = [{ message: 'nope', slug: 'jobs' }]

  it('says nothing was deleted only when nothing was', () => {
    expect(offboardingStoppedMessage({ errors: refused, kept: [], removed: [], tenant: 7 })).toBe(
      'Offboarding stopped. Nothing was deleted.',
    )
  })

  it('names what already went when a later collection was refused', () => {
    const message = offboardingStoppedMessage({
      errors: refused,
      kept: [],
      removed: [{ docs: 4, slug: 'pages' }],
      tenant: 7,
    })

    expect(message).not.toMatch(/Nothing was deleted/)
    expect(message).toMatch(/4 pages/)
  })
})
