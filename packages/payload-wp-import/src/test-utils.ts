import type { MysqlReader } from './mysql-reader'
import type { Importer, ImportPayload } from './types'

type Doc = Record<string, any> & { id: number }

/** In-memory stand-in for the Payload local API, supporting the `and`/`equals` queries the runner uses. */
export const createFakePayload = (seed: Record<string, Doc[]> = {}) => {
  const store: Record<string, Doc[]> = structuredClone(seed)
  const writes: { op: 'create' | 'update'; collection: string }[] = []
  let nextId = 1000

  const matches = (doc: Doc, where: any): boolean =>
    ((where.and ?? [where]) as Record<string, { equals: unknown }>[]).every((clause) =>
      Object.entries(clause).every(([field, { equals }]) => doc[field] === equals),
    )

  const payload: ImportPayload = {
    async find({ collection, where }) {
      return { docs: (store[collection] ?? []).filter((doc) => matches(doc, where)) }
    },
    async create({ collection, data }) {
      writes.push({ op: 'create', collection })
      const doc = { ...data, id: nextId++ }
      ;(store[collection] ??= []).push(doc)
      return doc
    },
    async update({ collection, data, id }) {
      writes.push({ op: 'update', collection })
      const doc = store[collection]!.find((candidate) => candidate.id === id)!
      Object.assign(doc, data)
      return doc
    },
  }

  return { payload, store, writes }
}

export const fakeReader = {} as MysqlReader

export const rowsImporter = (
  name: string,
  rows: { id: number; title?: string }[],
  overrides: Partial<Importer> = {},
): Importer => ({
  name,
  collection: name,
  dependsOn: [],
  read: () => rows,
  map: (row) => ({ legacyId: row.id, data: { title: row.title ?? `Item ${row.id}` } }),
  ...overrides,
})
