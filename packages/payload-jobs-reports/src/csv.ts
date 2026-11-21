/**
 * CSV writing for the reports (PJ-53). Two hazards: cells that spreadsheets run as formulas
 * (`=`, `+`, `-`, `@`, tab, CR at the start of a text cell), and cells that break the row
 * (commas, quotes, newlines).
 */

const FORMULA_START = /^[=+\-@\t\r]/

/** One cell as text. Numbers and booleans pass through; text is made formula-safe. */
export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  let text = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : JSON.stringify(value)

  // A leading apostrophe makes Excel, Sheets and LibreOffice treat the cell as plain text.
  if (FORMULA_START.test(text)) text = `'${text}`

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Header row then data rows, CRLF separated, columns in `columns` order. */
export const toCSV = (columns: string[], rows: Record<string, unknown>[]): string =>
  [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join(
    '\r\n',
  ) + '\r\n'
