import { describe, expect, it } from 'vitest'

import { csvCell, toCSV } from './csv'
import { isCalendarDay, monthOf, resolveRange, startOfDay } from './range'

describe('csv @S-104 @S-105', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12)).toBe('12')
  })

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', '=HYPERLINK("http://x","y")'])(
    'defuses the formula %j',
    (value) => {
      const cell = csvCell(value)
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true)
    },
  )

  it('leaves negative numbers and ordinary text alone', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('Welder - Port Vila')).toBe('Welder - Port Vila')
  })

  it('writes the header and only the requested columns, CRLF separated', () => {
    expect(toCSV(['b', 'a'], [{ a: 1, b: '=x', c: 'ignored' }])).toBe("b,a\r\n'=x,1\r\n")
  })
})

describe('range @S-104', () => {
  it('rejects bad days and inverted ranges', () => {
    expect(isCalendarDay('2026-02-31')).toBe(false)
    expect(isCalendarDay('2026-02-28')).toBe(true)
    expect(() => resolveRange('2026-4-1', undefined, 'UTC')).toThrow(RangeError)
    expect(() => resolveRange('2026-04-02', '2026-04-01', 'UTC')).toThrow(/after/)
  })

  it('includes the whole `to` day in the tenant timezone', () => {
    // Pacific/Efate is UTC+11 all year.
    expect(resolveRange('2026-03-01', '2026-03-31', 'Pacific/Efate')).toEqual({
      end: '2026-03-31T13:00:00.000Z',
      start: '2026-02-28T13:00:00.000Z',
    })
    expect(resolveRange('2026-03-01', '2026-03-31', 'UTC')).toEqual({
      end: '2026-04-01T00:00:00.000Z',
      start: '2026-03-01T00:00:00.000Z',
    })
    expect(resolveRange(undefined, undefined, 'UTC')).toEqual({})
  })

  it('handles daylight saving zones', () => {
    // Auckland moved to NZDT (UTC+13) on 2026-09-27.
    expect(new Date(startOfDay('2026-10-01', 'Pacific/Auckland')).toISOString()).toBe('2026-09-30T11:00:00.000Z')
    expect(new Date(startOfDay('2026-07-01', 'Pacific/Auckland')).toISOString()).toBe('2026-06-30T12:00:00.000Z')
  })

  it('buckets months by the tenant timezone', () => {
    expect(monthOf('2026-03-31T13:30:00.000Z', 'Pacific/Efate')).toBe('2026-04')
    expect(monthOf('2026-03-31T13:30:00.000Z', 'UTC')).toBe('2026-03')
  })
})
