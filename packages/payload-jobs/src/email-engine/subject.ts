/**
 * Insert a variable into a subject at the end, with one space before it when needed. The editor's
 * "Insert variable" picker uses it; keeping it out of the client component makes it testable.
 */
export const insertVariable = (subject: string | null | undefined, key: string): string => {
  const current = subject ?? ''
  const gap = current === '' || /\s$/.test(current) ? '' : ' '

  return `${current}${gap}{{${key}}}`
}
