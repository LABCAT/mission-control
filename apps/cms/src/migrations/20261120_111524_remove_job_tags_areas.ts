import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "job_tags" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "job_tags_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "job_tags_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "areas_of_focus" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "areas_of_focus_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "areas_of_focus_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "job_tags" CASCADE;
  DROP TABLE "job_tags_locales" CASCADE;
  DROP TABLE "job_tags_rels" CASCADE;
  DROP TABLE "areas_of_focus" CASCADE;
  DROP TABLE "areas_of_focus_locales" CASCADE;
  DROP TABLE "areas_of_focus_rels" CASCADE;
  ALTER TABLE "organisations_rels" DROP CONSTRAINT IF EXISTS "organisations_rels_areas_of_focus_fk";
  
  ALTER TABLE "jobs_rels" DROP CONSTRAINT IF EXISTS "jobs_rels_job_tags_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_job_tags_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_areas_of_focus_fk";
  
  DROP INDEX "organisations_rels_areas_of_focus_id_idx";
  DROP INDEX "tenant_slug_5_idx";
  DROP INDEX "tenant_slug_7_idx";
  DROP INDEX "jobs_rels_job_tags_id_idx";
  DROP INDEX "payload_locked_documents_rels_job_tags_id_idx";
  DROP INDEX "payload_locked_documents_rels_areas_of_focus_id_idx";
  CREATE UNIQUE INDEX "tenant_slug_4_idx" ON "salary_bands" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_5_idx" ON "jobs" USING btree ("tenant_id","slug");
  ALTER TABLE "organisations_rels" DROP COLUMN "areas_of_focus_id";
  ALTER TABLE "jobs_rels" DROP COLUMN "job_tags_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "job_tags_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "areas_of_focus_id";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "job_tags" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "job_tags_locales" (
  	"name" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "job_tags_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "areas_of_focus" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"slug" varchar NOT NULL,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "areas_of_focus_locales" (
  	"name" varchar NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "areas_of_focus_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  DROP INDEX "tenant_slug_4_idx";
  DROP INDEX "tenant_slug_5_idx";
  ALTER TABLE "organisations_rels" ADD COLUMN "areas_of_focus_id" integer;
  ALTER TABLE "jobs_rels" ADD COLUMN "job_tags_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "job_tags_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "areas_of_focus_id" integer;
  ALTER TABLE "job_tags" ADD CONSTRAINT "job_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "job_tags_locales" ADD CONSTRAINT "job_tags_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."job_tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "job_tags_rels" ADD CONSTRAINT "job_tags_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."job_tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "job_tags_rels" ADD CONSTRAINT "job_tags_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "areas_of_focus" ADD CONSTRAINT "areas_of_focus_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "areas_of_focus_locales" ADD CONSTRAINT "areas_of_focus_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."areas_of_focus"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "areas_of_focus_rels" ADD CONSTRAINT "areas_of_focus_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."areas_of_focus"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "areas_of_focus_rels" ADD CONSTRAINT "areas_of_focus_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "job_tags_tenant_idx" ON "job_tags" USING btree ("tenant_id");
  CREATE INDEX "job_tags_legacy_id_idx" ON "job_tags" USING btree ("legacy_id");
  CREATE INDEX "job_tags_updated_at_idx" ON "job_tags" USING btree ("updated_at");
  CREATE INDEX "job_tags_created_at_idx" ON "job_tags" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_slug_4_idx" ON "job_tags" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "job_tags_locales_parent_id_locale_unique" ON "job_tags_locales" USING btree ("_parent_id","_locale");
  CREATE INDEX "job_tags_rels_order_idx" ON "job_tags_rels" USING btree ("order");
  CREATE INDEX "job_tags_rels_parent_idx" ON "job_tags_rels" USING btree ("parent_id");
  CREATE INDEX "job_tags_rels_path_idx" ON "job_tags_rels" USING btree ("path");
  CREATE INDEX "job_tags_rels_users_id_idx" ON "job_tags_rels" USING btree ("users_id");
  CREATE INDEX "areas_of_focus_tenant_idx" ON "areas_of_focus" USING btree ("tenant_id");
  CREATE INDEX "areas_of_focus_legacy_id_idx" ON "areas_of_focus" USING btree ("legacy_id");
  CREATE INDEX "areas_of_focus_updated_at_idx" ON "areas_of_focus" USING btree ("updated_at");
  CREATE INDEX "areas_of_focus_created_at_idx" ON "areas_of_focus" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_slug_6_idx" ON "areas_of_focus" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "areas_of_focus_locales_parent_id_locale_unique" ON "areas_of_focus_locales" USING btree ("_parent_id","_locale");
  CREATE INDEX "areas_of_focus_rels_order_idx" ON "areas_of_focus_rels" USING btree ("order");
  CREATE INDEX "areas_of_focus_rels_parent_idx" ON "areas_of_focus_rels" USING btree ("parent_id");
  CREATE INDEX "areas_of_focus_rels_path_idx" ON "areas_of_focus_rels" USING btree ("path");
  CREATE INDEX "areas_of_focus_rels_users_id_idx" ON "areas_of_focus_rels" USING btree ("users_id");
  ALTER TABLE "organisations_rels" ADD CONSTRAINT "organisations_rels_areas_of_focus_fk" FOREIGN KEY ("areas_of_focus_id") REFERENCES "public"."areas_of_focus"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "jobs_rels" ADD CONSTRAINT "jobs_rels_job_tags_fk" FOREIGN KEY ("job_tags_id") REFERENCES "public"."job_tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_job_tags_fk" FOREIGN KEY ("job_tags_id") REFERENCES "public"."job_tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_areas_of_focus_fk" FOREIGN KEY ("areas_of_focus_id") REFERENCES "public"."areas_of_focus"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "organisations_rels_areas_of_focus_id_idx" ON "organisations_rels" USING btree ("areas_of_focus_id");
  CREATE UNIQUE INDEX "tenant_slug_5_idx" ON "salary_bands" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_7_idx" ON "jobs" USING btree ("tenant_id","slug");
  CREATE INDEX "jobs_rels_job_tags_id_idx" ON "jobs_rels" USING btree ("job_tags_id");
  CREATE INDEX "payload_locked_documents_rels_job_tags_id_idx" ON "payload_locked_documents_rels" USING btree ("job_tags_id");
  CREATE INDEX "payload_locked_documents_rels_areas_of_focus_id_idx" ON "payload_locked_documents_rels" USING btree ("areas_of_focus_id");`)
}
