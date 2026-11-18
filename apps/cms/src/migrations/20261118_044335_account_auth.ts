import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_users_tenants_role" ADD VALUE 'seeker';
  ALTER TABLE "users" ADD COLUMN "_verified" boolean;
  ALTER TABLE "users" ADD COLUMN "_verificationtoken" varchar;
  -- Every user that exists before email verification is switched on is already trusted: they were
  -- created in the admin or imported. Without this nobody could log in until verified.
  UPDATE "users" SET "_verified" = true;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM "users_tenants" WHERE "role" = 'seeker') THEN
     RAISE EXCEPTION 'Cannot roll back account_auth: users still have the seeker role. Remove or reassign them first.';
    END IF;
   END $$;
  ALTER TABLE "users_tenants" ALTER COLUMN "role" SET DATA TYPE text;
  DROP TYPE "public"."enum_users_tenants_role";
  CREATE TYPE "public"."enum_users_tenants_role" AS ENUM('tenant-admin', 'editor', 'employer');
  ALTER TABLE "users_tenants" ALTER COLUMN "role" SET DATA TYPE "public"."enum_users_tenants_role" USING "role"::"public"."enum_users_tenants_role";
  ALTER TABLE "users" DROP COLUMN "_verified";
  ALTER TABLE "users" DROP COLUMN "_verificationtoken";`)
}
