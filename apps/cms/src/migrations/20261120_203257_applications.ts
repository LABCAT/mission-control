import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "application_files" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"organisation_id" integer NOT NULL,
  	"applicant_id" integer,
  	"prefix" varchar DEFAULT '',
  	"_objectkey" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"original_filename" varchar,
  	"original_url" varchar,
  	"original_mime_type" varchar,
  	"original_filesize" numeric,
  	"original_width" numeric,
  	"original_height" numeric,
  	"original_prefix" varchar,
  	"original__objectkey" varchar,
  	"focal_x" numeric,
  	"focal_y" numeric
  );
  
  CREATE TABLE "application_files_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "applications" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"job_id" integer NOT NULL,
  	"organisation_id" integer,
  	"applicant_id" integer,
  	"name" varchar NOT NULL,
  	"email" varchar NOT NULL,
  	"phone" varchar,
  	"message" varchar,
  	"cv_id" integer NOT NULL,
  	"cover_letter_id" integer,
  	"consent_at" timestamp(3) with time zone NOT NULL,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "applications_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "tenants" ADD COLUMN "account_required_to_apply" boolean DEFAULT false;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "application_files_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "applications_id" integer;
  ALTER TABLE "application_files" ADD CONSTRAINT "application_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "application_files" ADD CONSTRAINT "application_files_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "application_files" ADD CONSTRAINT "application_files_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "application_files_rels" ADD CONSTRAINT "application_files_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."application_files"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "application_files_rels" ADD CONSTRAINT "application_files_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "applications" ADD CONSTRAINT "applications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "applications" ADD CONSTRAINT "applications_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "applications" ADD CONSTRAINT "applications_cv_id_application_files_id_fk" FOREIGN KEY ("cv_id") REFERENCES "public"."application_files"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "applications" ADD CONSTRAINT "applications_cover_letter_id_application_files_id_fk" FOREIGN KEY ("cover_letter_id") REFERENCES "public"."application_files"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "applications_rels" ADD CONSTRAINT "applications_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "applications_rels" ADD CONSTRAINT "applications_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "application_files_tenant_idx" ON "application_files" USING btree ("tenant_id");
  CREATE INDEX "application_files_organisation_idx" ON "application_files" USING btree ("organisation_id");
  CREATE INDEX "application_files_applicant_idx" ON "application_files" USING btree ("applicant_id");
  CREATE INDEX "application_files_updated_at_idx" ON "application_files" USING btree ("updated_at");
  CREATE INDEX "application_files_created_at_idx" ON "application_files" USING btree ("created_at");
  CREATE UNIQUE INDEX "application_files_filename_idx" ON "application_files" USING btree ("filename");
  CREATE INDEX "application_files_original_original_filename_idx" ON "application_files" USING btree ("original_filename");
  CREATE INDEX "application_files_rels_order_idx" ON "application_files_rels" USING btree ("order");
  CREATE INDEX "application_files_rels_parent_idx" ON "application_files_rels" USING btree ("parent_id");
  CREATE INDEX "application_files_rels_path_idx" ON "application_files_rels" USING btree ("path");
  CREATE INDEX "application_files_rels_users_id_idx" ON "application_files_rels" USING btree ("users_id");
  CREATE INDEX "applications_tenant_idx" ON "applications" USING btree ("tenant_id");
  CREATE INDEX "applications_job_idx" ON "applications" USING btree ("job_id");
  CREATE INDEX "applications_organisation_idx" ON "applications" USING btree ("organisation_id");
  CREATE INDEX "applications_applicant_idx" ON "applications" USING btree ("applicant_id");
  CREATE INDEX "applications_email_idx" ON "applications" USING btree ("email");
  CREATE INDEX "applications_cv_idx" ON "applications" USING btree ("cv_id");
  CREATE INDEX "applications_cover_letter_idx" ON "applications" USING btree ("cover_letter_id");
  CREATE INDEX "applications_legacy_id_idx" ON "applications" USING btree ("legacy_id");
  CREATE INDEX "applications_updated_at_idx" ON "applications" USING btree ("updated_at");
  CREATE INDEX "applications_created_at_idx" ON "applications" USING btree ("created_at");
  CREATE INDEX "applications_rels_order_idx" ON "applications_rels" USING btree ("order");
  CREATE INDEX "applications_rels_parent_idx" ON "applications_rels" USING btree ("parent_id");
  CREATE INDEX "applications_rels_path_idx" ON "applications_rels" USING btree ("path");
  CREATE INDEX "applications_rels_users_id_idx" ON "applications_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_application_files_fk" FOREIGN KEY ("application_files_id") REFERENCES "public"."application_files"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_applications_fk" FOREIGN KEY ("applications_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_application_files_id_idx" ON "payload_locked_documents_rels" USING btree ("application_files_id");
  CREATE INDEX "payload_locked_documents_rels_applications_id_idx" ON "payload_locked_documents_rels" USING btree ("applications_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "application_files" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "application_files_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "applications" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "applications_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "application_files" CASCADE;
  DROP TABLE "application_files_rels" CASCADE;
  DROP TABLE "applications" CASCADE;
  DROP TABLE "applications_rels" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_application_files_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_applications_fk";
  
  DROP INDEX "payload_locked_documents_rels_application_files_id_idx";
  DROP INDEX "payload_locked_documents_rels_applications_id_idx";
  ALTER TABLE "tenants" DROP COLUMN "account_required_to_apply";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "application_files_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "applications_id";`)
}
