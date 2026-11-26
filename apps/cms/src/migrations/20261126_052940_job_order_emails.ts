import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'job-submitted-admin' BEFORE 'job-approved';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'job-edited-pending' BEFORE 'job-approved';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'job-expired' BEFORE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'order-created' BEFORE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'order-created-admin' BEFORE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'order-paid' BEFORE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'order-cancelled' BEFORE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'organisation-page-requested' BEFORE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'organisation-page-approved' BEFORE 'application-received';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Refuse rather than delete data: the old enum cannot hold the new events.
  const used = await db.execute(sql`
   SELECT DISTINCT "event" FROM "email_templates"
   WHERE "event" IN ('job-submitted-admin', 'job-edited-pending', 'job-expired', 'order-created', 'order-created-admin', 'order-paid', 'order-cancelled', 'organisation-page-requested', 'organisation-page-approved')`)
  const events = used.rows.map((row) => String(row.event))
  if (events.length > 0) {
    throw new Error(
      `Rollback refused: email_templates rows still use ${events.join(', ')}. Remove or change those templates first.`,
    )
  }
  await db.execute(sql`
   ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE text;
  DROP TYPE "public"."enum_email_templates_event";
  CREATE TYPE "public"."enum_email_templates_event" AS ENUM('job-submitted', 'job-approved', 'application-received', 'application-copy', 'application-admin-copy');
  ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE "public"."enum_email_templates_event" USING "event"::"public"."enum_email_templates_event";`)
}
