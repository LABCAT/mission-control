import { crc32 } from 'node:zlib'

import { payloadJobs } from '@mission-control/payload-jobs'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { r2Storage } from '@payloadcms/storage-r2'
import { buildConfig, getPayload, type Payload } from 'payload'
import sharp from 'sharp'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Documents, DOCUMENT_MAX_BYTES } from './collections/Documents'
import { Folders } from './collections/Folders'
import { Media } from './collections/Media'
import { SiteKeys } from './collections/SiteKeys'
import { Tags } from './collections/Tags'
import { Tenants } from './collections/Tenants'
import { Users } from './collections/Users'
import { createMediaTransformers, mediaVariants } from './media'
import { multiTenantOptions } from './tenancy'

const databaseUrl = process.env.TEST_DATABASE_URL

// wrangler's local miniflare R2 stands in for the production `MEDIA` bucket.
let platform: PlatformProxy<{ MEDIA: R2Bucket }>
let bucket: R2Bucket
let payload: Payload
let workerPayload: Payload

type Actor = { collection: 'users'; id: number; role: 'super-admin' | 'user'; tenants: unknown[] }
let tenantA: { id: number }
let tenantB: { id: number }
let superAdmin: Actor
let adminA: Actor
let editorA: Actor
let employerA: Actor
let adminB: Actor

const png = (width: number, height: number) =>
  sharp({ create: { background: '#336699', channels: 3, height, width } }).png().toBuffer()

const file = (data: Buffer, name: string, mimetype: string) => ({
  data,
  mimetype,
  name,
  size: data.length,
})

const uploadMedia = async (user: Actor | undefined, tenant: number, name: string, data: Buffer) =>
  payload.create({
    collection: 'media',
    data: { alt: name, tenant },
    file: file(data, name, 'image/png'),
    overrideAccess: false,
    user: user as never,
  })

/** Payload validates PDF structure: a header, an xref table and an EOF marker. */
const pdf = (size = 128) => {
  const head = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')
  const tail = Buffer.from('xref\n0 1\ntrailer\n<<>>\nstartxref\n0\n%%EOF\n')

  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length - tail.length), 0x20), tail])
}

/** A stored (uncompressed) zip with the entries Word writes, so it is sniffed as DOCX. */
const docx = () => {
  const entries = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const name of entries) {
    const nameBuf = Buffer.from(name)
    const body = Buffer.from(
      name === '[Content_Types].xml'
        ? '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
        : '<x/>',
    )
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(body), 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(body.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    const entry = Buffer.concat([header, nameBuf, body])
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt32LE(crc32(body), 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(body.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([dir, nameBuf]))
    parts.push(entry)
    offset += entry.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...parts, centralBuf, end])
}

/** Legacy Word files are OLE compound documents. */
const doc = () =>
  Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(504, 0),
  ])

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const uploadDocument = async (
  user: Actor | undefined,
  tenant: number,
  name: string,
  data: Buffer,
  mimetype = 'application/pdf',
) =>
  payload.create({
    collection: 'documents',
    data: { tenant, title: name },
    file: file(data, name, mimetype),
    overrideAccess: false,
    user: user as never,
  })

// Unique per run so rows left by an aborted run can't match.
const LEGACY_ID = Math.floor(Date.now() / 1000)

const objectKeys = async () => (await bucket.list()).objects.map((object) => object.key)

/** R2 keys are `<objectKey>/<filename>`: each upload gets its own folder, so names never collide. */
const keyOf = (doc: Record<string, any>, filename: string = doc.filename) =>
  `${doc._objectKey}/${filename}`

describe.skipIf(!databaseUrl)('media and documents (R2, tenant scoped)', () => {
  beforeAll(async () => {
    // `persist: false` keeps the bucket in memory, so runs never touch .wrangler state.
    platform = await getPlatformProxy<{ MEDIA: R2Bucket }>({
      configPath: new URL('../wrangler.jsonc', import.meta.url).pathname,
      persist: false,
    })
    bucket = platform.env.MEDIA

    const makeConfig = async (isWorkers: boolean) =>
      buildConfig({
        admin: { user: 'users' },
        auth: { passwordHashIterations: 100000 },
        collections: [Users, Media, Folders, Tags, Tenants, SiteKeys, Documents],
        // A private schema, so pushing these tables never races other suites on the shared database.
        db: postgresAdapter({
          pool: { connectionString: databaseUrl, max: 10 },
          push: true,
          schemaName: 'media_test',
        }),
        plugins: [payloadJobs({ tenancy: 'multi' }), multiTenantPlugin(multiTenantOptions)],
        secret: 'test-secret',
        storage: [r2Storage({ bucket, collections: { documents: true, media: true } })],
        upload: { transformers: await createMediaTransformers(isWorkers) },
      })
    payload = await getPayload({ config: await makeConfig(false), key: 'media-test' })

    // The production Worker's config: same schema, but no resizing (see createMediaTransformers).
    workerPayload = await getPayload({
      config: await makeConfig(true),
      key: 'media-test-worker',
    })

    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const tenant = async (slug: string) =>
      (await payload.create({
        collection: 'tenants',
        data: {
          adminEmail: `admin@${slug}.example.invalid`,
          currency: 'VUV',
          currencyMinorUnits: 0,
          defaultLocale: 'en',
          emailFromAddress: `noreply@${slug}.example.invalid`,
          emailFromName: slug,
          locales: [{ locale: 'en' }],
          name: slug,
          slug: `${slug}-${run}`,
          taxLabel: 'VAT',
          timezone: 'Pacific/Efate',
        } as never,
        overrideAccess: true,
      })) as unknown as { id: number }
    tenantA = await tenant('a')
    tenantB = await tenant('b')

    const user = async (name: string, role: 'super-admin' | 'user', tenants: unknown[]) => {
      const doc = await payload.create({
        collection: 'users',
        data: { email: `${name}-${run}@example.invalid`, password: 'test-password', role, tenants } as never,
        overrideAccess: true,
      })
      return { collection: 'users' as const, id: doc.id as number, role, tenants }
    }
    superAdmin = await user('super', 'super-admin', [])
    adminA = await user('admin-a', 'user', [{ role: 'tenant-admin', tenant: tenantA.id }])
    editorA = await user('editor-a', 'user', [{ role: 'editor', tenant: tenantA.id }])
    employerA = await user('employer-a', 'user', [{ role: 'employer', tenant: tenantA.id }])
    adminB = await user('admin-b', 'user', [{ role: 'tenant-admin', tenant: tenantB.id }])
  }, 120_000)

  afterAll(async () => {
    if (payload && tenantA && tenantB) {
      const where = { tenant: { in: [tenantA.id, tenantB.id] } }
      for (const collection of ['media', 'documents'] as const) {
        await payload.delete({ collection, overrideAccess: true, where })
      }
      await payload.delete({
        collection: 'users',
        overrideAccess: true,
        where: { id: { in: [superAdmin, adminA, editorA, employerA, adminB].map((u) => u?.id) } },
      })
      await payload.delete({ collection: 'tenants', overrideAccess: true, where: { id: { in: [tenantA.id, tenantB.id] } } })
    }
    await workerPayload?.destroy()
    await payload?.destroy()
    await platform?.dispose()
  })

  describe('media', () => {
    it('stores the original and every variant in R2', async () => {
      const doc = (await uploadMedia(adminA, tenantA.id, 'hero.png', await png(2000, 1500))) as Record<
        string,
        any
      >

      const keys = await objectKeys()
      expect(keys).toContain(keyOf(doc))
      expect(mediaVariants.map((variant) => variant.name)).toHaveLength(8)

      for (const width of [320, 640, 960, 1280]) {
        for (const format of ['avif', 'webp']) {
          const variant = doc.variants[`w${width}-${format}`]
          expect(variant.width).toBe(width)
          expect(variant.mimeType).toBe(`image/${format}`)
          expect(keys).toContain(keyOf(doc, variant.filename))
        }
      }
    })

    it('never enlarges an image smaller than a variant', async () => {
      const doc = (await uploadMedia(adminA, tenantA.id, 'small.png', await png(500, 300))) as Record<
        string,
        any
      >

      expect(doc.variants['w320-webp'].width).toBe(320)
      for (const name of ['w640', 'w960', 'w1280']) {
        expect(doc.variants[`${name}-webp`].width).toBeLessThanOrEqual(500)
      }
    })

    it('deletes the original and variants from R2 with the document', async () => {
      const doc = (await uploadMedia(adminA, tenantA.id, 'temp.png', await png(1000, 800))) as Record<
        string,
        any
      >
      const names = [keyOf(doc), keyOf(doc, doc.variants['w320-avif'].filename)]
      expect(await objectKeys()).toEqual(expect.arrayContaining(names))

      await payload.delete({ collection: 'media', id: doc.id, overrideAccess: false, user: adminA as never })

      const remaining = await objectKeys()
      for (const name of names) expect(remaining).not.toContain(name)
    })

    it('rejects non-image uploads', async () => {
      await expect(
        payload.create({
          collection: 'media',
          data: { alt: 'doc', tenant: tenantA.id },
          file: file(pdf(), 'cv.pdf', 'application/pdf'),
          overrideAccess: false,
          user: adminA as never,
        }),
      ).rejects.toThrow()
    })

    it('adds an indexed numeric legacyId', async () => {
      const doc = await payload.create({
        collection: 'media',
        data: { alt: 'legacy', legacyId: LEGACY_ID, tenant: tenantA.id },
        file: file(await png(400, 400), 'legacy.png', 'image/png'),
        overrideAccess: false,
        user: adminA as never,
      })
      const found = await payload.find({
        collection: 'media',
        overrideAccess: true,
        where: { legacyId: { equals: LEGACY_ID } },
      })

      expect(found.docs.map((d) => d.id)).toEqual([doc.id])
    })

    it('scopes writes to the user’s tenants', async () => {
      const png1 = await png(400, 400)

      await expect(uploadMedia(adminB, tenantA.id, 'x.png', png1)).rejects.toThrow()
      await expect(uploadMedia(undefined, tenantA.id, 'y.png', png1)).rejects.toThrow()
      await expect(uploadMedia(editorA, tenantA.id, 'editor.png', png1)).resolves.toBeTruthy()
      await expect(uploadMedia(employerA, tenantA.id, 'employer.png', png1)).resolves.toBeTruthy()
    })

    it('blocks another tenant’s admin from updating or deleting media', async () => {
      const doc = await uploadMedia(adminA, tenantA.id, 'guarded.png', await png(400, 400))

      await expect(
        payload.update({
          collection: 'media',
          data: { alt: 'hijacked' },
          id: doc.id,
          overrideAccess: false,
          user: adminB as never,
        }),
      ).rejects.toThrow()
      await expect(
        payload.delete({ collection: 'media', id: doc.id, overrideAccess: false, user: adminB as never }),
      ).rejects.toThrow()
    })

    it('falls back to the original when an image has no variants (Worker uploads)', async () => {
      const doc = (await workerPayload.create({
        collection: 'media',
        data: { alt: 'no variants', tenant: tenantA.id },
        file: file(await png(1600, 900), 'plain.png', 'image/png'),
        overrideAccess: true,
      })) as Record<string, any>

      // Sites render `url`; with no variants it must still point at the original.
      expect(doc.url).toBe(`/api/media/file/${doc.filename}`)
      expect(doc.width).toBe(1600)
      expect(await objectKeys()).toContain(keyOf(doc))
      for (const variant of mediaVariants) {
        expect(doc.variants[variant.name].url ?? null).toBeNull()
        expect(doc.variants[variant.name].filename ?? null).toBeNull()
      }
    })

    it('stays publicly readable', async () => {
      const { docs } = await payload.find({ collection: 'media', overrideAccess: false })

      expect(docs.length).toBeGreaterThan(0)
    })
  })

  describe('documents', () => {
    it('stores a PDF in R2 for a tenant member', async () => {
      const doc = await uploadDocument(editorA, tenantA.id, 'brief.pdf', pdf())

      expect(await objectKeys()).toContain(keyOf(doc))
    })

    it('accepts DOC and DOCX', async () => {
      await expect(
        uploadDocument(adminA, tenantA.id, 'old.doc', doc(), 'application/msword'),
      ).resolves.toBeTruthy()
      await expect(
        uploadDocument(
          adminA,
          tenantA.id,
          'new.docx',
          docx(),
          DOCX_MIME,
        ),
      ).resolves.toBeTruthy()
    })

    it('rejects other file types', async () => {
      await expect(
        uploadDocument(adminA, tenantA.id, 'pic.png', await png(50, 50), 'image/png'),
      ).rejects.toThrow()
      await expect(
        uploadDocument(adminA, tenantA.id, 'run.exe', pdf(), 'application/x-msdownload'),
      ).rejects.toThrow()
      // A declared PDF whose bytes are an image is caught by Payload's content sniffing.
      await expect(
        uploadDocument(adminA, tenantA.id, 'fake.pdf', await png(50, 50), 'application/pdf'),
      ).rejects.toThrow()
    })

    it('enforces the 10 MB limit', async () => {
      const exactly = pdf(DOCUMENT_MAX_BYTES)
      const tooBig = pdf(DOCUMENT_MAX_BYTES + 1)

      expect(exactly.length).toBe(DOCUMENT_MAX_BYTES)
      await expect(uploadDocument(adminA, tenantA.id, 'max.pdf', exactly)).resolves.toBeTruthy()
      await expect(uploadDocument(adminA, tenantA.id, 'big.pdf', tooBig)).rejects.toThrow(/10 MB/)
    })

    it('adds an indexed numeric legacyId', async () => {
      const doc = await payload.create({
        collection: 'documents',
        data: { legacyId: LEGACY_ID, tenant: tenantA.id, title: 'legacy' },
        file: file(pdf(), 'legacy.pdf', 'application/pdf'),
        overrideAccess: true,
      })
      const found = await payload.find({
        collection: 'documents',
        overrideAccess: true,
        where: { legacyId: { equals: LEGACY_ID } },
      })

      expect(found.docs.map((d) => d.id)).toEqual([doc.id])
    })

    it('is private: anonymous requests see nothing, and tenant B cannot see tenant A', async () => {
      const doc = await uploadDocument(adminA, tenantA.id, 'private.pdf', pdf())

      await expect(payload.find({ collection: 'documents', overrideAccess: false })).rejects.toThrow(
        /not allowed/,
      )

      const asB = await payload.find({
        collection: 'documents',
        overrideAccess: false,
        user: adminB as never,
      })
      expect(asB.docs.map((d) => d.id)).not.toContain(doc.id)

      const asA = await payload.find({
        collection: 'documents',
        overrideAccess: false,
        user: adminA as never,
      })
      expect(asA.docs.map((d) => d.id)).toContain(doc.id)
    })

    it('rejects cross-tenant writes', async () => {
      const doc = await uploadDocument(adminA, tenantA.id, 'owned.pdf', pdf())

      await expect(uploadDocument(adminB, tenantA.id, 'x.pdf', pdf())).rejects.toThrow()
      await expect(uploadDocument(undefined, tenantA.id, 'y.pdf', pdf())).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'documents',
          data: { title: 'hijacked' },
          id: doc.id,
          overrideAccess: false,
          user: adminB as never,
        }),
      ).rejects.toThrow()
      await expect(
        payload.delete({ collection: 'documents', id: doc.id, overrideAccess: false, user: adminB as never }),
      ).rejects.toThrow()
    })

    it('lets a super-admin see every tenant', async () => {
      await uploadDocument(adminB, tenantB.id, 'b.pdf', pdf())

      const { docs } = await payload.find({
        collection: 'documents',
        limit: 200,
        overrideAccess: false,
        user: superAdmin as never,
        where: { tenant: { in: [tenantA.id, tenantB.id] } },
      })
      const tenants = new Set(docs.map((d) => (typeof d.tenant === 'object' ? d.tenant?.id : d.tenant)))

      expect(tenants).toEqual(new Set([tenantA.id, tenantB.id]))
    })
  })
})
