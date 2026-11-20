import { describe, expect, it } from 'vitest'

import {
  automatedResult,
  buildReport,
  CSV_COLUMNS,
  parseCatalogue,
  parseResults,
  renderCsv,
  renderMarkdown,
  tagsIn,
} from './report.mjs'

const catalogue = (stories: string) => `
meta:
  title: Test
stories:
${stories}
`

const story = (id: string, overrides = '') => `
  - id: ${id}
    area: Test area
    role: seeker
    story: A test story.
    steps:
      - Do the thing.
    expected: The thing happens.
    settings: []
    mvp: true
    status: planned
    tests: []
${overrides}`

describe('catalogue parsing', () => {
  it('normalizes optional manual and notes fields and keeps lists', () => {
    const { stories } = parseCatalogue(catalogue(story('S-001')))
    expect(stories).toHaveLength(1)
    expect(stories[0]).toMatchObject({
      id: 'S-001',
      manual: '',
      notes: '',
      settings: [],
      tests: [],
      steps: ['Do the thing.'],
    })
  })

  it('rejects a duplicate story id', () => {
    expect(() => parseCatalogue(catalogue(story('S-001') + story('S-001')))).toThrow(
      'duplicate id S-001',
    )
  })

  it('rejects an unknown role', () => {
    expect(() =>
      parseCatalogue(catalogue(story('S-001').replace('role: seeker', 'role: visitor'))),
    ).toThrow('role must be one of')
  })

  it('rejects an unknown status', () => {
    expect(() =>
      parseCatalogue(catalogue(story('S-001').replace('status: planned', 'status: shipped'))),
    ).toThrow('status must be one of')
  })
})

describe('vitest results and tags', () => {
  it('reads assertionResults from the JSON reporter', () => {
    const results = parseResults(
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              {
                ancestorTitles: ['plans'],
                title: 'quotes a listing @S-001',
                status: 'passed',
              },
              { fullName: 'an untagged test', status: 'failed' },
            ],
          },
        ],
      }),
    )

    expect(results).toEqual([
      { title: 'plans quotes a listing @S-001', status: 'passed' },
      { title: 'an untagged test', status: 'failed' },
    ])
  })

  it('finds each story tag once, case-insensitively', () => {
    expect(tagsIn('a test @S-001 and @s-001 and @S-042')).toEqual(['@S-001', '@S-042'])
    expect(tagsIn('no tags here')).toEqual([])
  })
})

describe('story matching and the failure rule', () => {
  const stories = [
    {
      id: 'S-001',
      mvp: true,
      status: 'built',
      story: 'Built MVP.',
      area: 'A',
      role: 'seeker',
      steps: [],
      expected: '',
      settings: [],
      tests: [],
      manual: '',
      notes: '',
    },
    {
      id: 'S-002',
      mvp: true,
      status: 'planned',
      story: 'Planned MVP.',
      area: 'A',
      role: 'seeker',
      steps: [],
      expected: '',
      settings: [],
      tests: [],
      manual: '',
      notes: '',
    },
    {
      id: 'S-003',
      mvp: true,
      status: 'built',
      story: 'Built but failing.',
      area: 'A',
      role: 'seeker',
      steps: [],
      expected: '',
      settings: [],
      tests: [],
      manual: '',
      notes: '',
    },
    {
      id: 'S-004',
      mvp: false,
      status: 'built',
      story: 'Built non-MVP.',
      area: 'A',
      role: 'seeker',
      steps: [],
      expected: '',
      settings: [],
      tests: [],
      manual: '',
      notes: '',
    },
  ]

  it('reports pass, fail and untested per story', () => {
    const report = buildReport(stories, [
      { title: 'one @S-001', status: 'passed' },
      { title: 'two @S-003', status: 'failed' },
      { title: 'three @S-004', status: 'skipped' },
    ])

    expect(report.stories.map((entry) => [entry.id, entry.automated])).toEqual([
      ['S-001', 'pass'],
      ['S-002', 'untested'],
      ['S-003', 'fail'],
      ['S-004', 'untested'],
    ])
  })

  it('fails only an MVP story marked built with no matching test', () => {
    const report = buildReport(stories, [
      { title: 'one @S-001', status: 'passed' },
      { title: 'two @S-003', status: 'passed' },
    ])

    expect(report.failures.map((entry) => entry.id)).toEqual([])

    const missing = buildReport(stories, [{ title: 'two @S-003', status: 'passed' }])
    expect(missing.failures.map((entry) => entry.id)).toEqual(['S-001'])
  })

  it('a matched but skipped test does not count as evidence', () => {
    const report = buildReport(stories, [{ title: 'one @S-001', status: 'skipped' }])
    expect(report.stories[0].automated).toBe('untested')
    expect(report.failures.map((entry) => entry.id)).toContain('S-001')
  })

  it('collects tags that have no story instead of dropping them', () => {
    const report = buildReport(stories, [{ title: 'one @S-999', status: 'passed' }])
    expect(report.unknownTags).toEqual(['@S-999'])
  })

  it('treats only failed and passed as results', () => {
    expect(automatedResult([])).toBe('untested')
    expect(automatedResult(['passed', 'failed'])).toBe('fail')
    expect(automatedResult(['pending'])).toBe('untested')
  })
})

describe('exports', () => {
  it('keeps the YCV column order and escapes CSV values', () => {
    const csv = renderCsv([
      {
        id: 'S-001',
        area: 'A, B',
        role: 'seeker',
        story: 'He said "yes".',
        steps: ['First step', 'Second step'],
        expected: 'It works.',
        automated: 'pass',
        manual: '',
        notes: '',
      },
    ])
    const [header, row] = csv.split('\n')

    expect(header).toBe(CSV_COLUMNS.join(','))
    expect(row).toContain('"A, B"')
    expect(row).toContain('"He said ""yes""."')
    expect(row).toContain('"First step; Second step"')
  })

  it('summarizes counts and names the blocked stories in markdown', () => {
    const report = buildReport(storiesFixture(), [])
    const markdown = renderMarkdown(report)

    expect(markdown).toContain('**1 stories** · 1 MVP · 1 built')
    expect(markdown).toContain('## MVP stories marked built with no test')
    expect(markdown).toContain('**S-001**')
  })
})

const storiesFixture = () => [
  {
    id: 'S-001',
    mvp: true,
    status: 'built',
    story: 'Built MVP.',
    area: 'A',
    role: 'seeker',
    steps: [],
    expected: '',
    settings: [],
    tests: [],
    manual: '',
    notes: '',
  },
]
