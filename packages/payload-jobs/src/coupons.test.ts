import type { AccessArgs, CollectionConfig, Field, NumberField, TextField } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MissionControlUser } from './access'
import {
  applyCoupon,
  COUPON_USE_COUNT_CONTEXT,
  COUPONS_SLUG,
  couponCollection,
  normalizeCouponCode,
  protectCouponUseCount,
  validateCouponAmount,
  validateCouponCode,
  validateCouponMaxUses,
  validateCouponUseCount,
} from './coupons'
import { bootTestPayload, tenantIsolation, type TestHarness } from './test'
import { removeTenantCoupons } from './coupons'

const fieldNamed = (collection: CollectionConfig, name: string): Field => {
  const field = collection.fields.find(
    (candidate) => 'name' in candidate && candidate.name === name,
  )
  if (!field) throw new Error(`${collection.slug} is missing ${name}`)
  return field
}

const userWith = (
  tenants: { role: 'editor' | 'employer' | 'tenant-admin'; tenant: number }[],
  role: 'super-admin' | 'user' = 'user',
): MissionControlUser => ({ id: 1, role, tenants })

const argsFor = (user: MissionControlUser | null, data?: Record<string, unknown>) =>
  ({ data, req: { user } }) as unknown as AccessArgs

describe('coupon collection config @S-037', () => {
  const collection = couponCollection()

  it('defines the coupon fields the legacy plugin had', () => {
    expect(collection.slug).toBe(COUPONS_SLUG)

    expect(fieldNamed(collection, 'code')).toMatchObject({ required: true, type: 'text' })
    expect(fieldNamed(collection, 'discountType')).toMatchObject({
      defaultValue: 'flat',
      required: true,
      type: 'select',
    })
    expect(fieldNamed(collection, 'amount')).toMatchObject({ required: true, type: 'number' })
    expect(fieldNamed(collection, 'active')).toMatchObject({
      defaultValue: true,
      type: 'checkbox',
    })
    expect(fieldNamed(collection, 'useCount')).toMatchObject({ defaultValue: 0, type: 'number' })
    expect(fieldNamed(collection, 'maxUses')).toMatchObject({ type: 'number' })
  })

  it('offers exactly the flat and percentage discount types', () => {
    const discountType = fieldNamed(collection, 'discountType')

    expect(discountType.type).toBe('select')
    expect((discountType as { options: unknown }).options).toEqual([
      { label: 'Flat amount', value: 'flat' },
      { label: 'Percentage', value: 'percent' },
    ])
  })

  it('indexes legacyId for the WordPress import and leaves it optional', () => {
    const legacyId = fieldNamed(collection, 'legacyId') as NumberField

    expect(legacyId).toMatchObject({ index: true, type: 'number' })
    expect(legacyId.required).toBeFalsy()
  })

  it('makes the code unique per tenant, not across tenants', () => {
    const code = fieldNamed(collection, 'code') as TextField

    expect(code.unique).toBeFalsy()
    expect(code.validate).toBe(validateCouponCode)
    expect(collection.indexes).toEqual([{ fields: ['tenant', 'code'], unique: true }])
  })

  it('skips versions so Payload does not create a _v table', () => {
    expect(collection.versions).toBe(false)
  })

  it('drops the tenant scope and the compound index in single-tenant mode', () => {
    const single = couponCollection({ tenantScoped: false })

    expect(single.indexes).toEqual([])
    expect((fieldNamed(single, 'code') as TextField).unique).toBe(true)
  })
})

describe('coupon code handling @S-037', () => {
  it('normalises a code to uppercase and trims it', () => {
    expect(normalizeCouponCode(' linkps ')).toBe('LINKPS')
    expect(normalizeCouponCode('linkps')).toBe('LINKPS')
  })

  it('accepts uppercase codes and rejects anything else', () => {
    expect(validateCouponCode('LINKPS')).toBe(true)
    expect(validateCouponCode('XMAS-2026')).toBe(true)
    expect(validateCouponCode('TEN_PCT')).toBe(true)
    expect(validateCouponCode('linkps')).toMatch(/uppercase/)
    expect(validateCouponCode('LINK PS')).toMatch(/uppercase/)
    expect(validateCouponCode('-LINKPS')).toMatch(/uppercase/)
    expect(validateCouponCode('')).toMatch(/uppercase/)
    expect(validateCouponCode(undefined)).toMatch(/uppercase/)
  })
})

const sibling = (discountType: 'flat' | 'percent'): { siblingData: Record<string, unknown> } => ({
  siblingData: { discountType },
})

describe('coupon field validation @S-037', () => {
  it('requires a positive flat amount in minor units', () => {
    expect(validateCouponAmount(500, sibling('flat'))).toBe(true)
    expect(validateCouponAmount(0, sibling('flat'))).toMatch(/1 or more/)
    expect(validateCouponAmount(12.5, sibling('flat'))).toMatch(/whole number/)
    expect(validateCouponAmount(null, sibling('flat'))).toMatch(/required/)
  })

  it('requires a whole percentage from 1 to 100', () => {
    expect(validateCouponAmount(10, sibling('percent'))).toBe(true)
    expect(validateCouponAmount(100, sibling('percent'))).toBe(true)
    expect(validateCouponAmount(0, sibling('percent'))).toMatch(/1 and 100/)
    expect(validateCouponAmount(101, sibling('percent'))).toMatch(/1 and 100/)
    expect(validateCouponAmount(12.5, sibling('percent'))).toMatch(/whole percentage/)
  })

  it('keeps useCount at or above zero and maxUses above zero', () => {
    expect(validateCouponUseCount(0)).toBe(true)
    expect(validateCouponUseCount(undefined)).toBe(true)
    expect(validateCouponUseCount(null)).toMatch(/0 or more/)
    expect(validateCouponUseCount(-1)).toMatch(/0 or more/)

    expect(validateCouponMaxUses(1)).toBe(true)
    expect(validateCouponMaxUses(undefined)).toBe(true)
    expect(validateCouponMaxUses(0)).toMatch(/1 or more/)
  })
})

describe('coupon access control', () => {
  const collection = couponCollection()
  const read = collection.access?.read
  const create = collection.access?.create
  const update = collection.access?.update
  if (!read || !create || !update) throw new Error('Missing coupon access functions')

  it('keeps anonymous reads closed', async () => {
    expect(await read(argsFor(null))).toBe(false)
  })

  it('scopes a tenant-admin update to their own tenants', async () => {
    const tenantAdmin = userWith([{ role: 'tenant-admin', tenant: 10 }])

    expect(await update(argsFor(tenantAdmin))).toEqual({ tenant: { in: [10] } })
    expect(await update(argsFor(tenantAdmin, { tenant: 20 }))).toBe(false)
  })

  it('lets a tenant-admin create inside their own tenant only', async () => {
    const tenantAdmin = userWith([{ role: 'tenant-admin', tenant: 10 }])

    expect(await create(argsFor(tenantAdmin, { tenant: 10 }))).toBe(true)
    expect(await create(argsFor(tenantAdmin, { tenant: 20 }))).toBe(false)
  })

  it('refuses a tenant-admin create with no tenant, which a where cannot filter', async () => {
    const tenantAdmin = userWith([{ role: 'tenant-admin', tenant: 10 }])

    expect(await create(argsFor(tenantAdmin))).toBe(false)
    expect(await create(argsFor(tenantAdmin, { tenant: null }))).toBe(false)
    expect(await create(argsFor(tenantAdmin, { code: 'LINKPS' }))).toBe(false)
  })

  it('does not let an editor or an employer change coupons', async () => {
    const editor = userWith([{ role: 'editor', tenant: 10 }])
    const employer = userWith([{ role: 'employer', tenant: 10 }])

    expect(await create(argsFor(editor, { tenant: 10 }))).toBe(false)
    expect(await update(argsFor(editor, { tenant: 10 }))).toBe(false)
    expect(await create(argsFor(employer, { tenant: 10 }))).toBe(false)
    expect(await update(argsFor(employer, { tenant: 10 }))).toBe(false)
  })

  it('lets a super-admin write any tenant and denies an anonymous write', async () => {
    const superAdmin = userWith([], 'super-admin')

    expect(await create(argsFor(superAdmin, { tenant: 20 }))).toBe(true)
    expect(await update(argsFor(superAdmin, { tenant: 20 }))).toBe(true)
    expect(await create(argsFor(null))).toBe(false)
    expect(await update(argsFor(null))).toBe(false)
  })

  it('makes a super-admin name a tenant when creating, so no coupon is orphaned', async () => {
    const superAdmin = userWith([], 'super-admin')

    expect(await create(argsFor(superAdmin))).toBe(false)
    expect(await create(argsFor(superAdmin, { tenant: null }))).toBe(false)
    expect(await create(argsFor(superAdmin, { code: 'LINKPS' }))).toBe(false)
  })

  it('drops the tenant filter but keeps the role check in single-tenant mode', async () => {
    const single = couponCollection({ tenantScoped: false })
    const singleCreate = single.access?.create
    const singleUpdate = single.access?.update
    if (!singleCreate || !singleUpdate) throw new Error('Missing coupon access')

    const tenantAdmin = userWith([{ role: 'tenant-admin', tenant: 10 }])
    expect(await singleCreate(argsFor(tenantAdmin))).toBe(true)
    expect(await singleUpdate(argsFor(tenantAdmin))).toBe(true)

    expect(await singleCreate(argsFor(userWith([], 'super-admin')))).toBe(true)
    expect(await singleUpdate(argsFor(userWith([], 'super-admin')))).toBe(true)
  })

  it('keeps a plain user and a non-admin member from writing coupons in single-tenant mode', async () => {
    const single = couponCollection({ tenantScoped: false })
    const singleCreate = single.access?.create
    const singleUpdate = single.access?.update
    if (!singleCreate || !singleUpdate) throw new Error('Missing coupon access')

    const plainUser = userWith([], 'user')
    const editor = userWith([{ role: 'editor', tenant: 10 }])
    const employer = userWith([{ role: 'employer', tenant: 10 }])

    expect(await singleCreate(argsFor(plainUser))).toBe(false)
    expect(await singleUpdate(argsFor(plainUser))).toBe(false)
    expect(await singleCreate(argsFor(editor))).toBe(false)
    expect(await singleUpdate(argsFor(editor))).toBe(false)
    expect(await singleCreate(argsFor(employer))).toBe(false)
    expect(await singleUpdate(argsFor(employer))).toBe(false)
    expect(await singleCreate(argsFor(null))).toBe(false)
  })
})

const guard = (args: Record<string, unknown>) => protectCouponUseCount(args as never)

describe('useCount guard @S-037', () => {
  it('starts a new coupon at zero however the request asks for more', () => {
    expect(guard({ data: { code: 'LINKPS', useCount: 0 }, operation: 'create' })).toEqual({
      code: 'LINKPS',
      useCount: 0,
    })
    expect(
      guard({ data: { code: 'LINKPS', useCount: 5 }, operation: 'create' }),
    ).toEqual({ code: 'LINKPS', useCount: 0 })
  })

  it('pins an existing count when a tenant admin tries to lower it', () => {
    const args = {
      data: { useCount: 0 },
      operation: 'update',
      originalDoc: { id: 1, tenant: 10, useCount: 3 },
    }

    expect(guard(args)).toEqual({ useCount: 3 })
  })

  it('pins the count on an update that omits it too', () => {
    expect(
      guard({ data: { code: 'LINKPS' }, operation: 'update', originalDoc: { useCount: 2 } }),
    ).toEqual({ code: 'LINKPS', useCount: 2 })
  })

  it('leaves an unchanged count alone', () => {
    const data = { code: 'LINKPS', useCount: 2 }

    expect(guard({ data, operation: 'update', originalDoc: { useCount: 2 } })).toBe(data)
  })

  it('treats an explicit null as a change, not an omission', () => {
    expect(
      guard({ data: { useCount: null }, operation: 'update', originalDoc: { useCount: 3 } }),
    ).toEqual({ useCount: 3 })
    expect(guard({ data: { useCount: null }, operation: 'create' })).toEqual({ useCount: 0 })
  })

  it('lets trusted order processing change the count', () => {
    const data = { useCount: 4 }

    expect(
      guard({
        context: { [COUPON_USE_COUNT_CONTEXT]: true },
        data,
        operation: 'update',
        originalDoc: { useCount: 3 },
      }),
    ).toBe(data)
  })
})

describe('applyCoupon @S-037', () => {
  it('rejects a subtotal that is not exact in a JS number', () => {
    expect(() => applyCoupon({ subtotal: 1e20 })).toThrow(RangeError)
    expect(() => applyCoupon({ subtotal: Number.MAX_SAFE_INTEGER + 2 })).toThrow(RangeError)
  })

  it('refuses unsafe amounts and counts instead of returning imprecise money', () => {
    const base = { active: true, discountType: 'flat' as const }

    expect(applyCoupon({ coupon: { ...base, amount: 1e20 }, subtotal: 5000 }).reason).toBe('invalid-amount')
    expect(applyCoupon({ coupon: { ...base, amount: 100, maxUses: 1.5 }, subtotal: 5000 }).reason).toBe('invalid-amount')
    expect(applyCoupon({ coupon: { ...base, amount: 100, useCount: -1 }, subtotal: 5000 }).reason).toBe('invalid-amount')
  })

  it('takes a percentage with the shared exact rounding, even on large safe subtotals', () => {
    const subtotal = 9_007_199_254_740_991 // Number.MAX_SAFE_INTEGER
    const result = applyCoupon({ coupon: { active: true, amount: 50, discountType: 'percent' }, subtotal })

    expect(result.discount).toBe(4_503_599_627_370_496) // exactly half, halves rounded up
    expect(result.total).toBe(subtotal - result.discount)
  })

  it('returns the subtotal untouched when no coupon is given', () => {
    expect(applyCoupon({ subtotal: 5000 })).toEqual({
      applied: false,
      discount: 0,
      reason: null,
      total: 5000,
    })
    expect(applyCoupon({ coupon: null, subtotal: 5000 }).total).toBe(5000)
  })

  it('subtracts a flat amount in minor units', () => {
    expect(
      applyCoupon({ coupon: { active: true, amount: 1500, discountType: 'flat' }, subtotal: 5000 }),
    ).toEqual({ applied: true, discount: 1500, reason: null, total: 3500 })
  })

  it('subtracts a percentage of the subtotal, rounding to whole minor units', () => {
    expect(
      applyCoupon({
        coupon: { active: true, amount: 10, discountType: 'percent' },
        subtotal: 10000,
      }),
    ).toEqual({ applied: true, discount: 1000, reason: null, total: 9000 })

    // 10% of Vt 9 999 is 999.9 minor units; money is kept whole.
    expect(
      applyCoupon({ coupon: { active: true, amount: 10, discountType: 'percent' }, subtotal: 9999 })
        .discount,
    ).toBe(1000)
  })

  it('floors the total at zero when the discount exceeds the subtotal', () => {
    const flat = applyCoupon({
      coupon: { active: true, amount: 9000, discountType: 'flat' },
      subtotal: 5000,
    })
    expect(flat).toEqual({ applied: true, discount: 5000, reason: null, total: 0 })

    const percent = applyCoupon({
      coupon: { active: true, amount: 100, discountType: 'percent' },
      subtotal: 5000,
    })
    expect(percent).toEqual({ applied: true, discount: 5000, reason: null, total: 0 })
  })

  it('refuses a coupon that has reached maxUses', () => {
    const usedUp = applyCoupon({
      coupon: { active: true, amount: 1000, discountType: 'flat', maxUses: 3, useCount: 3 },
      subtotal: 5000,
    })
    expect(usedUp).toEqual({ applied: false, discount: 0, reason: 'used-up', total: 5000 })

    const belowLimit = applyCoupon({
      coupon: { active: true, amount: 1000, discountType: 'flat', maxUses: 3, useCount: 2 },
      subtotal: 5000,
    })
    expect(belowLimit.applied).toBe(true)
  })

  it('treats a missing maxUses as unlimited', () => {
    const result = applyCoupon({
      coupon: { active: true, amount: 1000, discountType: 'flat', useCount: 900 },
      subtotal: 5000,
    })
    expect(result).toMatchObject({ applied: true, discount: 1000 })
  })

  it('refuses an inactive coupon', () => {
    expect(
      applyCoupon({
        coupon: { active: false, amount: 1000, discountType: 'flat' },
        subtotal: 5000,
      }),
    ).toEqual({ applied: false, discount: 0, reason: 'inactive', total: 5000 })
  })

  it('rejects a coupon with an invalid amount or an unknown discount type', () => {
    expect(
      applyCoupon({ coupon: { active: true, amount: null, discountType: 'flat' }, subtotal: 100 })
        .reason,
    ).toBe('invalid-amount')
    expect(
      applyCoupon({ coupon: { active: true, amount: -5, discountType: 'flat' }, subtotal: 100 })
        .reason,
    ).toBe('invalid-amount')
    expect(
      applyCoupon({ coupon: { active: true, amount: 0, discountType: 'flat' }, subtotal: 100 })
        .reason,
    ).toBe('invalid-amount')
    expect(
      applyCoupon({ coupon: { active: true, amount: 0, discountType: 'percent' }, subtotal: 100 })
        .reason,
    ).toBe('invalid-amount')
    expect(
      applyCoupon({ coupon: { active: true, amount: 101, discountType: 'percent' }, subtotal: 100 })
        .reason,
    ).toBe('invalid-amount')
    expect(
      applyCoupon({
        coupon: { active: true, amount: 10, discountType: 'bogus' as never },
        subtotal: 100,
      }).reason,
    ).toBe('unsupported-discount-type')
  })

  it('refuses a subtotal that is not whole non-negative minor units', () => {
    expect(() => applyCoupon({ subtotal: -1 })).toThrow(RangeError)
    expect(() => applyCoupon({ subtotal: 12.5 })).toThrow(RangeError)
  })
})

describe('coupons in Postgres @S-037', () => {
  let harness: TestHarness
  let employer: { id: number | string }

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: [couponCollection()] })

    employer = await harness.payload.create({
      collection: 'users',
      data: {
        email: `employer-${Date.now().toString(36)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants: [{ role: 'employer', tenant: harness.tenantA.id }],
      },
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('saves the code in uppercase', async () => {
    const coupon = await harness.payload.create({
      collection: COUPONS_SLUG,
      data: {
        amount: 500,
        code: ' linkps ',
        discountType: 'flat',
        tenant: harness.tenantA.id,
      } as never,
      user: harness.tenantAdminA as never,
    })

    expect(coupon.code).toBe('LINKPS')
    expect(coupon.useCount).toBe(0)
    expect(coupon.active).toBe(true)
  })

  it('rejects the same code twice in one tenant', async () => {
    const attempt = harness.payload.create({
      collection: COUPONS_SLUG,
      data: { amount: 250, code: 'linkps', discountType: 'flat', tenant: harness.tenantA.id } as never,
      user: harness.tenantAdminA as never,
    })

    await expect(attempt).rejects.toThrow()
    await expect(attempt).rejects.toMatchObject({
      data: { errors: [{ message: 'Code "LINKPS" is already used in this tenant' }] },
    })
  })

  it('allows the same code on another tenant', async () => {
    const coupon = await harness.payload.create({
      collection: COUPONS_SLUG,
      data: { amount: 250, code: 'LINKPS', discountType: 'flat', tenant: harness.tenantB.id } as never,
      user: harness.tenantAdminB as never,
    })

    expect(coupon.code).toBe('LINKPS')
  })

  it('refuses a coupon created without a tenant over the API', async () => {
    await expect(
      harness.payload.create({
        collection: COUPONS_SLUG,
        data: {
          amount: 500,
          code: 'ORPHAN',
          discountType: 'flat',
        } as never,
        user: harness.tenantAdminA as never,
      }),
    ).rejects.toThrow(/not allowed/i)

    await expect(
      harness.payload.create({
        collection: COUPONS_SLUG,
        data: {
          amount: 500,
          code: 'FOREIGN',
          discountType: 'flat',
          tenant: harness.tenantB.id,
        } as never,
        user: harness.tenantAdminA as never,
      }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('refuses a super-admin coupon created without a tenant over the API', async () => {
    await expect(
      harness.payload.create({
        collection: COUPONS_SLUG,
        data: {
          amount: 500,
          code: 'SUPERORPHAN',
          discountType: 'flat',
        } as never,
        user: harness.superAdmin as never,
      }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('refuses an update that clears the tenant, for a tenant admin and a super admin, and keeps an omitted one', async () => {
    const made = (await harness.payload.create({
      collection: COUPONS_SLUG,
      data: { amount: 500, code: 'KEEPTENANT', discountType: 'flat', tenant: harness.tenantA.id } as never,
      overrideAccess: true,
    })) as unknown as { id: number }

    for (const user of [harness.tenantAdminA, harness.superAdmin]) {
      await expect(
        harness.payload.update({
          collection: COUPONS_SLUG,
          data: { tenant: null } as never,
          id: made.id,
          overrideAccess: false,
          user: user as never,
        }),
      ).rejects.toThrow()
    }

    const after = (await harness.payload.update({
      collection: COUPONS_SLUG,
      data: { amount: 600 } as never,
      id: made.id,
      overrideAccess: false,
      user: harness.tenantAdminA as never,
    })) as unknown as { tenant: number | { id: number } }
    expect(typeof after.tenant === 'object' ? after.tenant.id : after.tenant).toBe(harness.tenantA.id)
  })

  it('keeps a tenant admin from resetting useCount over the API', async () => {
    const coupon = await harness.payload.create({
      collection: COUPONS_SLUG,
      data: {
        amount: 500,
        code: 'LIMITED',
        discountType: 'flat',
        maxUses: 1,
        tenant: harness.tenantA.id,
      } as never,
      user: harness.tenantAdminA as never,
    })

    const spent = await harness.payload.update({
      collection: COUPONS_SLUG,
      id: coupon.id,
      context: { [COUPON_USE_COUNT_CONTEXT]: true },
      data: { useCount: 1 },
      user: harness.tenantAdminA as never,
      overrideAccess: true,
    })

    expect(spent.useCount).toBe(1)

    const reset = await harness.payload.update({
      collection: COUPONS_SLUG,
      id: coupon.id,
      data: { useCount: 0 },
      user: harness.tenantAdminA as never,
    })

    expect(reset.useCount).toBe(1)

    const cleared = await harness.payload.update({
      collection: COUPONS_SLUG,
      id: coupon.id,
      data: { useCount: null },
      user: harness.tenantAdminA as never,
    })

    expect(cleared.useCount).toBe(1)

    const created = await harness.payload.create({
      collection: COUPONS_SLUG,
      data: {
        amount: 100,
        code: 'PADDED',
        discountType: 'flat',
        tenant: harness.tenantA.id,
        useCount: 9,
      } as never,
      user: harness.tenantAdminA as never,
    })

    expect(created.useCount).toBe(0)
  })

  it('refuses a coupon from an employer', async () => {
    await expect(
      harness.payload.create({
        collection: COUPONS_SLUG,
        data: {
          amount: 100,
          code: 'EMPLOYER10',
          discountType: 'flat',
          tenant: harness.tenantA.id,
        } as never,
        user: employer as never,
      }),
    ).rejects.toThrow()
  })
})

tenantIsolation({
  collection: couponCollection(),
  createData: () => ({ amount: 500, code: 'ISOLATION', discountType: 'flat' }),
})

describe('coupons when a tenant is deleted @S-037', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [couponCollection()],
      tenantHooks: { beforeDelete: [removeTenantCoupons] },
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('deletes that tenant’s coupons instead of leaving them without a tenant', async () => {
    const make = (tenant: number, code: string) =>
      harness.payload.create({
        collection: COUPONS_SLUG,
        data: { amount: 100, code, discountType: 'flat', tenant } as never,
        overrideAccess: true,
      })
    // A tenant of its own: the harness tenants have user memberships the host removes in a hook.
    const doomed = (await harness.payload.create({
      collection: 'tenants',
      data: { name: 'Doomed', slug: `doomed-${Date.now()}` } as never,
      overrideAccess: true,
    })) as unknown as { id: number }
    await make(doomed.id, 'GONE')
    await make(harness.tenantB.id, 'STAYS')

    await harness.payload.delete({ collection: 'tenants', id: doomed.id, overrideAccess: true })

    const left = await harness.payload.find({ collection: COUPONS_SLUG, depth: 0, overrideAccess: true })
    expect(left.docs.map((doc) => (doc as unknown as { code: string }).code)).toEqual(['STAYS'])
  })
})
