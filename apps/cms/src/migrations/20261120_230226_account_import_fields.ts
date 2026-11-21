import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_organisation_role" AS ENUM('owner', 'member');
  ALTER TABLE "users" ADD COLUMN "legacy_id" numeric;
  ALTER TABLE "users" ADD COLUMN "organisation_role" "enum_users_organisation_role";
  CREATE INDEX "users_legacy_id_idx" ON "users" USING btree ("legacy_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "users_legacy_id_idx";
  ALTER TABLE "users" DROP COLUMN "legacy_id";
  ALTER TABLE "users" DROP COLUMN "organisation_role";
  DROP TYPE "public"."enum_users_organisation_role";`)
}
