import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants" ADD COLUMN "session_default_days" numeric DEFAULT 1;
  ALTER TABLE "tenants" ADD COLUMN "session_keep_signed_in_days" numeric DEFAULT 30;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants" DROP COLUMN "session_default_days";
  ALTER TABLE "tenants" DROP COLUMN "session_keep_signed_in_days";`)
}
