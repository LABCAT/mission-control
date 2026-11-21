import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'xero-invoice-sync';
  ALTER TYPE "public"."enum_payload_jobs_log_parent_task_slug" ADD VALUE 'xero-invoice-sync';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'xero-invoice-sync';
  CREATE TABLE "xero_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"xero_tenant_id" varchar,
  	"account_codes_plan" varchar,
  	"account_codes_add_on" varchar,
  	"account_codes_discount" varchar,
  	"invoicing_authorise" boolean DEFAULT true,
  	"branding_theme_id" varchar,
  	"due_days" numeric DEFAULT 14,
  	"reconciliation_account_code" varchar,
  	"tracking_category_name" varchar,
  	"tracking_category_option" varchar,
  	"connected_at" timestamp(3) with time zone,
  	"tokens_access_token" varchar,
  	"tokens_expires_at" timestamp(3) with time zone,
  	"tokens_refresh_token" varchar,
  	"tokens_scope" varchar,
  	"tokens_refresh_lock_token" varchar,
  	"tokens_refresh_locked_until" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "xero_settings_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "xero_invoices" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"source" varchar NOT NULL,
  	"source_id" varchar NOT NULL,
  	"reference" varchar,
  	"invoice_id" varchar,
  	"invoice_number" varchar,
  	"status" varchar,
  	"online_url" varchar,
  	"attempts" numeric DEFAULT 0,
  	"last_error" varchar,
  	"last_attempt_at" timestamp(3) with time zone,
  	"lease_token" varchar,
  	"lease_until" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "xero_invoices_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "xero_settings_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "xero_invoices_id" integer;
  ALTER TABLE "xero_settings" ADD CONSTRAINT "xero_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "xero_settings_rels" ADD CONSTRAINT "xero_settings_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."xero_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "xero_settings_rels" ADD CONSTRAINT "xero_settings_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "xero_invoices" ADD CONSTRAINT "xero_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "xero_invoices_rels" ADD CONSTRAINT "xero_invoices_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."xero_invoices"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "xero_invoices_rels" ADD CONSTRAINT "xero_invoices_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "xero_settings_tenant_idx" ON "xero_settings" USING btree ("tenant_id");
  CREATE INDEX "xero_settings_updated_at_idx" ON "xero_settings" USING btree ("updated_at");
  CREATE INDEX "xero_settings_created_at_idx" ON "xero_settings" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_idx" ON "xero_settings" USING btree ("tenant_id");
  CREATE INDEX "xero_settings_rels_order_idx" ON "xero_settings_rels" USING btree ("order");
  CREATE INDEX "xero_settings_rels_parent_idx" ON "xero_settings_rels" USING btree ("parent_id");
  CREATE INDEX "xero_settings_rels_path_idx" ON "xero_settings_rels" USING btree ("path");
  CREATE INDEX "xero_settings_rels_users_id_idx" ON "xero_settings_rels" USING btree ("users_id");
  CREATE INDEX "xero_invoices_tenant_idx" ON "xero_invoices" USING btree ("tenant_id");
  CREATE INDEX "xero_invoices_invoice_id_idx" ON "xero_invoices" USING btree ("invoice_id");
  CREATE INDEX "xero_invoices_updated_at_idx" ON "xero_invoices" USING btree ("updated_at");
  CREATE INDEX "xero_invoices_created_at_idx" ON "xero_invoices" USING btree ("created_at");
  CREATE UNIQUE INDEX "source_sourceId_idx" ON "xero_invoices" USING btree ("source","source_id");
  CREATE INDEX "xero_invoices_rels_order_idx" ON "xero_invoices_rels" USING btree ("order");
  CREATE INDEX "xero_invoices_rels_parent_idx" ON "xero_invoices_rels" USING btree ("parent_id");
  CREATE INDEX "xero_invoices_rels_path_idx" ON "xero_invoices_rels" USING btree ("path");
  CREATE INDEX "xero_invoices_rels_users_id_idx" ON "xero_invoices_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_xero_settings_fk" FOREIGN KEY ("xero_settings_id") REFERENCES "public"."xero_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_xero_invoices_fk" FOREIGN KEY ("xero_invoices_id") REFERENCES "public"."xero_invoices"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_xero_settings_id_idx" ON "payload_locked_documents_rels" USING btree ("xero_settings_id");
  CREATE INDEX "payload_locked_documents_rels_xero_invoices_id_idx" ON "payload_locked_documents_rels" USING btree ("xero_invoices_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "xero_settings" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "xero_settings_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "xero_invoices" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "xero_invoices_rels" DISABLE ROW LEVEL SECURITY;
  -- mission-control: drop the foreign keys into the xero tables first; DROP TABLE ... CASCADE
  -- removes them, and the generated order then failed on the explicit DROP CONSTRAINT.
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_xero_settings_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_xero_invoices_fk";
  DROP TABLE "xero_settings" CASCADE;
  DROP TABLE "xero_settings_rels" CASCADE;
  DROP TABLE "xero_invoices" CASCADE;
  DROP TABLE "xero_invoices_rels" CASCADE;
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_parent_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_parent_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_parent_task_slug" USING "parent_task_slug"::"public"."enum_payload_jobs_log_parent_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'heartbeat', 'expire-job-placements');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "payload_locked_documents_rels_xero_settings_id_idx";
  DROP INDEX "payload_locked_documents_rels_xero_invoices_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "xero_settings_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "xero_invoices_id";`)
}
