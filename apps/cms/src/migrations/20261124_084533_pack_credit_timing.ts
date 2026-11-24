import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tenants_pack_credits_usable_at" AS ENUM('on_payment', 'on_invoice');
  ALTER TABLE "tenants" ADD COLUMN "pack_credits_usable_at" "enum_tenants_pack_credits_usable_at" DEFAULT 'on_payment';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants" DROP COLUMN "pack_credits_usable_at";
  DROP TYPE "public"."enum_tenants_pack_credits_usable_at";`)
}
