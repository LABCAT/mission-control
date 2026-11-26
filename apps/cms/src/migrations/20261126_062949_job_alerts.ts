import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_alert_subscriptions_frequency" AS ENUM('daily', 'weekly');
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'alert-confirm';
  ALTER TYPE "public"."enum_email_templates_event" ADD VALUE 'alert-manage-link';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'purge-unconfirmed-alerts' BEFORE 'xero-invoice-sync';
  ALTER TYPE "public"."enum_payload_jobs_log_parent_task_slug" ADD VALUE 'purge-unconfirmed-alerts' BEFORE 'xero-invoice-sync';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'purge-unconfirmed-alerts' BEFORE 'xero-invoice-sync';
  DROP INDEX "alert_subscriptions_confirm_token_idx";
  DROP INDEX "alert_subscriptions_manage_token_idx";
  DROP INDEX "tenant_email_idx";
  ALTER TABLE "tenants" ADD COLUMN "alerts_allow_without_account" boolean DEFAULT true;
  ALTER TABLE "tenants" ADD COLUMN "alerts_double_opt_in" boolean DEFAULT true;
  ALTER TABLE "tenants" ADD COLUMN "alerts_max_per_email" numeric DEFAULT 10;
  ALTER TABLE "alert_subscriptions" ADD COLUMN "frequency" "enum_alert_subscriptions_frequency" DEFAULT 'daily' NOT NULL;
  ALTER TABLE "alert_subscriptions" ADD COLUMN "active" boolean DEFAULT true;
  ALTER TABLE "alert_subscriptions" ADD COLUMN "filter_key" varchar;
  CREATE INDEX "alert_subscriptions_email_idx" ON "alert_subscriptions" USING btree ("email");
  CREATE INDEX "alert_subscriptions_active_idx" ON "alert_subscriptions" USING btree ("active");
  CREATE INDEX "alert_subscriptions_filter_key_idx" ON "alert_subscriptions" USING btree ("filter_key");
  CREATE UNIQUE INDEX "tenant_email_filterKey_idx" ON "alert_subscriptions" USING btree ("tenant_id","email","filter_key");
  ALTER TABLE "alert_subscriptions" DROP COLUMN "confirm_token";
  ALTER TABLE "alert_subscriptions" DROP COLUMN "manage_token";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Refuse rather than delete data: the old enums cannot hold the new values, and the old unique
  // index allowed one alert per address.
  const templates = await db.execute(sql`
   SELECT DISTINCT "event" FROM "email_templates" WHERE "event" IN ('alert-confirm', 'alert-manage-link')`)
  if (templates.rows.length > 0) {
    throw new Error(
      `Rollback refused: email_templates rows still use ${templates.rows.map((row) => String(row.event)).join(', ')}. Remove those templates first.`,
    )
  }

  const history = await db.execute(sql`
   SELECT 1 FROM "payload_jobs" WHERE "task_slug" = 'purge-unconfirmed-alerts'
   UNION ALL SELECT 1 FROM "payload_jobs_log" WHERE "task_slug" = 'purge-unconfirmed-alerts' OR "parent_task_slug" = 'purge-unconfirmed-alerts'
   LIMIT 1`)
  if (history.rows.length > 0) {
    throw new Error(
      'Rollback refused: payload_jobs / payload_jobs_log hold history for the purge-unconfirmed-alerts task. Review and clear those rows first, then migrate down again.',
    )
  }

  const several = await db.execute(sql`
   SELECT 1 FROM "alert_subscriptions" GROUP BY "tenant_id", "email" HAVING count(*) > 1 LIMIT 1`)
  if (several.rows.length > 0) {
    throw new Error(
      'Rollback refused: some address has more than one alert on a site, and the old schema allows one. Delete the extra alerts first.',
    )
  }

  await db.execute(sql`
   ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE text;
  DROP TYPE "public"."enum_email_templates_event";
  CREATE TYPE "public"."enum_email_templates_event" AS ENUM('job-submitted', 'job-submitted-admin', 'job-edited-pending', 'job-approved', 'job-expired', 'order-created', 'order-created-admin', 'order-paid', 'order-cancelled', 'organisation-page-requested', 'organisation-page-approved', 'application-received', 'application-copy', 'application-admin-copy');
  ALTER TABLE "email_templates" ALTER COLUMN "event" SET DATA TYPE "public"."enum_email_templates_event" USING "event"::"public"."enum_email_templates_event";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements', 'delete-expired-applications', 'email-log-retention', 'xero-invoice-sync');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_parent_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_parent_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements', 'delete-expired-applications', 'email-log-retention', 'xero-invoice-sync');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_parent_task_slug" USING "parent_task_slug"::"public"."enum_payload_jobs_log_parent_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements', 'delete-expired-applications', 'email-log-retention', 'xero-invoice-sync');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "alert_subscriptions_email_idx";
  DROP INDEX "alert_subscriptions_active_idx";
  DROP INDEX "alert_subscriptions_filter_key_idx";
  DROP INDEX "tenant_email_filterKey_idx";
  ALTER TABLE "alert_subscriptions" ADD COLUMN "confirm_token" varchar;
  ALTER TABLE "alert_subscriptions" ADD COLUMN "manage_token" varchar;
  CREATE UNIQUE INDEX "alert_subscriptions_confirm_token_idx" ON "alert_subscriptions" USING btree ("confirm_token");
  CREATE UNIQUE INDEX "alert_subscriptions_manage_token_idx" ON "alert_subscriptions" USING btree ("manage_token");
  CREATE UNIQUE INDEX "tenant_email_idx" ON "alert_subscriptions" USING btree ("tenant_id","email");
  ALTER TABLE "tenants" DROP COLUMN "alerts_allow_without_account";
  ALTER TABLE "tenants" DROP COLUMN "alerts_double_opt_in";
  ALTER TABLE "tenants" DROP COLUMN "alerts_max_per_email";
  ALTER TABLE "alert_subscriptions" DROP COLUMN "frequency";
  ALTER TABLE "alert_subscriptions" DROP COLUMN "active";
  ALTER TABLE "alert_subscriptions" DROP COLUMN "filter_key";
  DROP TYPE "public"."enum_alert_subscriptions_frequency";`)
}
