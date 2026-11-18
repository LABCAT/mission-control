import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tenants_job_moderation" AS ENUM('legacy', 'review', 'auto');
  CREATE TYPE "public"."enum_jobs_placements_placement" AS ENUM('featured-in-listings', 'featured-in-category');
  CREATE TYPE "public"."enum_jobs_status" AS ENUM('draft', 'pending', 'published', 'expired', 'cancelled');
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'expire-job-placements';
  ALTER TYPE "public"."enum_payload_jobs_log_parent_task_slug" ADD VALUE 'expire-job-placements';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'expire-job-placements';
  CREATE TABLE "jobs_placements" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"placement" "enum_jobs_placements_placement" NOT NULL,
  	"add_on_id" integer,
  	"starts_at" timestamp(3) with time zone NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "jobs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar,
  	"status" "enum_jobs_status" DEFAULT 'draft' NOT NULL,
  	"published_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone,
  	"organisation_id" integer NOT NULL,
  	"job_description_pdf_id" integer,
  	"job_type_id" integer,
  	"salary_band_id" integer,
  	"company_name" varchar,
  	"company_url" varchar,
  	"location_id" integer,
  	"address" varchar,
  	"apply_online" boolean DEFAULT true,
  	"applications_recipient" varchar,
  	"plan_id" integer,
  	"views" numeric DEFAULT 0,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "jobs_locales" (
  	"title" varchar NOT NULL,
  	"description" jsonb,
  	"displayed_salary" varchar,
  	"how_to_apply" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "jobs_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"job_categories_id" integer,
  	"job_tags_id" integer,
  	"users_id" integer
  );
  
  ALTER TABLE "tenants" ADD COLUMN "job_moderation" "enum_tenants_job_moderation" DEFAULT 'legacy';
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "jobs_id" integer;
  ALTER TABLE "jobs_placements" ADD CONSTRAINT "jobs_placements_add_on_id_add_ons_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_ons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs_placements" ADD CONSTRAINT "jobs_placements_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_description_pdf_id_documents_id_fk" FOREIGN KEY ("job_description_pdf_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_type_id_job_types_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_types"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_salary_band_id_salary_bands_id_fk" FOREIGN KEY ("salary_band_id") REFERENCES "public"."salary_bands"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs_locales" ADD CONSTRAINT "jobs_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "jobs_rels" ADD CONSTRAINT "jobs_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "jobs_rels" ADD CONSTRAINT "jobs_rels_job_categories_fk" FOREIGN KEY ("job_categories_id") REFERENCES "public"."job_categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "jobs_rels" ADD CONSTRAINT "jobs_rels_job_tags_fk" FOREIGN KEY ("job_tags_id") REFERENCES "public"."job_tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "jobs_rels" ADD CONSTRAINT "jobs_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "jobs_placements_order_idx" ON "jobs_placements" USING btree ("_order");
  CREATE INDEX "jobs_placements_parent_id_idx" ON "jobs_placements" USING btree ("_parent_id");
  CREATE INDEX "jobs_placements_add_on_idx" ON "jobs_placements" USING btree ("add_on_id");
  CREATE INDEX "jobs_placements_expires_at_idx" ON "jobs_placements" USING btree ("expires_at");
  CREATE INDEX "jobs_tenant_idx" ON "jobs" USING btree ("tenant_id");
  CREATE INDEX "jobs_slug_idx" ON "jobs" USING btree ("slug");
  CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");
  CREATE INDEX "jobs_published_at_idx" ON "jobs" USING btree ("published_at");
  CREATE INDEX "jobs_expires_at_idx" ON "jobs" USING btree ("expires_at");
  CREATE INDEX "jobs_organisation_idx" ON "jobs" USING btree ("organisation_id");
  CREATE INDEX "jobs_job_description_pdf_idx" ON "jobs" USING btree ("job_description_pdf_id");
  CREATE INDEX "jobs_job_type_idx" ON "jobs" USING btree ("job_type_id");
  CREATE INDEX "jobs_salary_band_idx" ON "jobs" USING btree ("salary_band_id");
  CREATE INDEX "jobs_location_idx" ON "jobs" USING btree ("location_id");
  CREATE INDEX "jobs_plan_idx" ON "jobs" USING btree ("plan_id");
  CREATE INDEX "jobs_legacy_id_idx" ON "jobs" USING btree ("legacy_id");
  CREATE INDEX "jobs_updated_at_idx" ON "jobs" USING btree ("updated_at");
  CREATE INDEX "jobs_created_at_idx" ON "jobs" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_slug_7_idx" ON "jobs" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "jobs_locales_parent_id_locale_unique" ON "jobs_locales" USING btree ("_parent_id","_locale");
  CREATE INDEX "jobs_rels_order_idx" ON "jobs_rels" USING btree ("order");
  CREATE INDEX "jobs_rels_parent_idx" ON "jobs_rels" USING btree ("parent_id");
  CREATE INDEX "jobs_rels_path_idx" ON "jobs_rels" USING btree ("path");
  CREATE INDEX "jobs_rels_job_categories_id_idx" ON "jobs_rels" USING btree ("job_categories_id");
  CREATE INDEX "jobs_rels_job_tags_id_idx" ON "jobs_rels" USING btree ("job_tags_id");
  CREATE INDEX "jobs_rels_users_id_idx" ON "jobs_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_jobs_fk" FOREIGN KEY ("jobs_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_jobs_id_idx" ON "payload_locked_documents_rels" USING btree ("jobs_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   -- mission-control: drop the locked-documents FK before the tables (the generated order fails).
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_jobs_fk";
  ALTER TABLE "jobs_placements" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "jobs" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "jobs_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "jobs_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "jobs_placements" CASCADE;
  DROP TABLE "jobs" CASCADE;
  DROP TABLE "jobs_locales" CASCADE;
  DROP TABLE "jobs_rels" CASCADE;
  
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'heartbeat');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_parent_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_parent_task_slug" AS ENUM('inline', 'heartbeat');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_parent_task_slug" USING "parent_task_slug"::"public"."enum_payload_jobs_log_parent_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'heartbeat');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_jobs_id_idx";
  ALTER TABLE "tenants" DROP COLUMN "job_moderation";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "jobs_id";
  DROP TYPE "public"."enum_tenants_job_moderation";
  DROP TYPE "public"."enum_jobs_placements_placement";
  DROP TYPE "public"."enum_jobs_status";`)
}
