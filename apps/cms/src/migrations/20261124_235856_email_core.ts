import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_email_templates_event" AS ENUM('job-submitted', 'job-approved');
  CREATE TYPE "public"."enum_email_log_status" AS ENUM('sent', 'failed', 'skipped');
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'email-log-retention' BEFORE 'xero-invoice-sync';
  ALTER TYPE "public"."enum_payload_jobs_log_parent_task_slug" ADD VALUE 'email-log-retention' BEFORE 'xero-invoice-sync';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'email-log-retention' BEFORE 'xero-invoice-sync';
  CREATE TABLE "email_templates" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"event" "enum_email_templates_event" NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"subject" varchar,
  	"body" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "email_templates_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "email_log" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"event" varchar NOT NULL,
  	"template_id" integer,
  	"linked_collection" varchar,
  	"linked_i_d" varchar,
  	"recipient" varchar,
  	"recipient_masked" boolean DEFAULT false,
  	"status" "enum_email_log_status" NOT NULL,
  	"reason" varchar,
  	"redirected" boolean DEFAULT false,
  	"sent_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "email_log_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "tenants" ADD COLUMN "email_branding_logo_url" varchar;
  ALTER TABLE "tenants" ADD COLUMN "email_branding_brand_colour" varchar;
  ALTER TABLE "tenants" ADD COLUMN "email_branding_background_colour" varchar;
  ALTER TABLE "tenants" ADD COLUMN "email_branding_footer" jsonb;
  ALTER TABLE "tenants" ADD COLUMN "email_log_retention_visible_days" numeric DEFAULT 90;
  ALTER TABLE "tenants" ADD COLUMN "email_log_retention_delete_months" numeric DEFAULT 12;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "email_templates_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "email_log_id" integer;
  ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "email_templates_rels" ADD CONSTRAINT "email_templates_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."email_templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "email_templates_rels" ADD CONSTRAINT "email_templates_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "email_log" ADD CONSTRAINT "email_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "email_log" ADD CONSTRAINT "email_log_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "email_log_rels" ADD CONSTRAINT "email_log_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."email_log"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "email_log_rels" ADD CONSTRAINT "email_log_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "email_templates_tenant_idx" ON "email_templates" USING btree ("tenant_id");
  CREATE INDEX "email_templates_event_idx" ON "email_templates" USING btree ("event");
  CREATE INDEX "email_templates_updated_at_idx" ON "email_templates" USING btree ("updated_at");
  CREATE INDEX "email_templates_created_at_idx" ON "email_templates" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_event_idx" ON "email_templates" USING btree ("tenant_id","event");
  CREATE INDEX "email_templates_rels_order_idx" ON "email_templates_rels" USING btree ("order");
  CREATE INDEX "email_templates_rels_parent_idx" ON "email_templates_rels" USING btree ("parent_id");
  CREATE INDEX "email_templates_rels_path_idx" ON "email_templates_rels" USING btree ("path");
  CREATE INDEX "email_templates_rels_users_id_idx" ON "email_templates_rels" USING btree ("users_id");
  CREATE INDEX "email_log_tenant_idx" ON "email_log" USING btree ("tenant_id");
  CREATE INDEX "email_log_event_idx" ON "email_log" USING btree ("event");
  CREATE INDEX "email_log_template_idx" ON "email_log" USING btree ("template_id");
  CREATE INDEX "email_log_recipient_masked_idx" ON "email_log" USING btree ("recipient_masked");
  CREATE INDEX "email_log_status_idx" ON "email_log" USING btree ("status");
  CREATE INDEX "email_log_sent_at_idx" ON "email_log" USING btree ("sent_at");
  CREATE INDEX "email_log_updated_at_idx" ON "email_log" USING btree ("updated_at");
  CREATE INDEX "email_log_created_at_idx" ON "email_log" USING btree ("created_at");
  CREATE INDEX "tenant_sentAt_idx" ON "email_log" USING btree ("tenant_id","sent_at");
  CREATE INDEX "email_log_rels_order_idx" ON "email_log_rels" USING btree ("order");
  CREATE INDEX "email_log_rels_parent_idx" ON "email_log_rels" USING btree ("parent_id");
  CREATE INDEX "email_log_rels_path_idx" ON "email_log_rels" USING btree ("path");
  CREATE INDEX "email_log_rels_users_id_idx" ON "email_log_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_email_templates_fk" FOREIGN KEY ("email_templates_id") REFERENCES "public"."email_templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_email_log_fk" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_log"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_email_templates_id_idx" ON "payload_locked_documents_rels" USING btree ("email_templates_id");
  CREATE INDEX "payload_locked_documents_rels_email_log_id_idx" ON "payload_locked_documents_rels" USING btree ("email_log_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_email_templates_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_email_log_fk";
  
  ALTER TABLE "email_templates" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "email_templates_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "email_log" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "email_log_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "email_templates" CASCADE;
  DROP TABLE "email_templates_rels" CASCADE;
  DROP TABLE "email_log" CASCADE;
  DROP TABLE "email_log_rels" CASCADE;
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements', 'delete-expired-applications', 'xero-invoice-sync');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_parent_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_parent_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements', 'delete-expired-applications', 'xero-invoice-sync');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_parent_task_slug" USING "parent_task_slug"::"public"."enum_payload_jobs_log_parent_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements', 'delete-expired-applications', 'xero-invoice-sync');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "payload_locked_documents_rels_email_templates_id_idx";
  DROP INDEX "payload_locked_documents_rels_email_log_id_idx";
  ALTER TABLE "tenants" DROP COLUMN "email_branding_logo_url";
  ALTER TABLE "tenants" DROP COLUMN "email_branding_brand_colour";
  ALTER TABLE "tenants" DROP COLUMN "email_branding_background_colour";
  ALTER TABLE "tenants" DROP COLUMN "email_branding_footer";
  ALTER TABLE "tenants" DROP COLUMN "email_log_retention_visible_days";
  ALTER TABLE "tenants" DROP COLUMN "email_log_retention_delete_months";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "email_templates_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "email_log_id";
  DROP TYPE "public"."enum_email_templates_event";
  DROP TYPE "public"."enum_email_log_status";`)
}
