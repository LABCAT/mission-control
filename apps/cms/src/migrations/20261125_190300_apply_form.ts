import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'application-copy';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'application-admin-copy';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE text;
  DROP TYPE "public"."enum_email_templates_event";
  CREATE TYPE "public"."enum_email_templates_event" AS ENUM('job-submitted', 'job-approved');
  ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE "public"."enum_email_templates_event" USING "event"::"public"."enum_email_templates_event";`)
}
