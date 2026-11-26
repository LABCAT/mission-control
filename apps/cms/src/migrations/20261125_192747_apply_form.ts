import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'application-received';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'application-copy';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'application-admin-copy';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Refuse rather than delete data: the old enum cannot hold the new events.
  const used = await db.execute(sql`
   SELECT DISTINCT "event" FROM "email_templates"
   WHERE "event" IN ('application-received', 'application-copy', 'application-admin-copy')`)
  const events = used.rows.map((row) => String(row.event))
  if (events.length > 0) {
    throw new Error(
      `Rollback refused: email_templates rows still use ${events.join(', ')}. Remove or change those templates first.`,
    )
  }
  await db.execute(sql`
   ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE text;
  DROP TYPE "public"."enum_email_templates_event";
  CREATE TYPE "public"."enum_email_templates_event" AS ENUM('job-submitted', 'job-approved');
  ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE "public"."enum_email_templates_event" USING "event"::"public"."enum_email_templates_event";`)
}
