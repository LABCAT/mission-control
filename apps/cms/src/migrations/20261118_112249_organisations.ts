import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_organisations_type" AS ENUM('business', 'government', 'nfp', 'consultant', 'recruiter', 'social-enterprise');
  CREATE TYPE "public"."enum_organisations_size" AS ENUM('1-10', '11-50', '51-200', '201-500', '500-plus');
  CREATE TABLE "organisations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"type" "enum_organisations_type",
  	"size" "enum_organisations_size",
  	"about" varchar,
  	"logo_id" integer,
  	"cover_id" integer,
  	"website" varchar,
  	"phone" varchar,
  	"location_id" integer,
  	"socials_facebook" varchar,
  	"socials_instagram" varchar,
  	"socials_linkedin" varchar,
  	"socials_x" varchar,
  	"socials_youtube" varchar,
  	"listing_requested" boolean DEFAULT false,
  	"approved" boolean DEFAULT false,
  	"page_enabled" boolean DEFAULT false,
  	"can_pay_by_invoice" boolean DEFAULT false,
  	"billing_email" varchar,
  	"xero_contact_code" varchar,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "organisations_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"areas_of_focus_id" integer,
  	"users_id" integer
  );
  
  DROP INDEX "tenant_slug_1_idx";
  DROP INDEX "tenant_slug_2_idx";
  DROP INDEX "tenant_slug_3_idx";
  DROP INDEX "tenant_slug_4_idx";
  DROP INDEX "tenant_slug_5_idx";
  ALTER TABLE "users" ADD COLUMN "organisation_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "organisations_id" integer;
  ALTER TABLE "organisations" ADD CONSTRAINT "organisations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "organisations" ADD CONSTRAINT "organisations_logo_id_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "organisations" ADD CONSTRAINT "organisations_cover_id_media_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "organisations" ADD CONSTRAINT "organisations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "organisations_rels" ADD CONSTRAINT "organisations_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "organisations_rels" ADD CONSTRAINT "organisations_rels_areas_of_focus_fk" FOREIGN KEY ("areas_of_focus_id") REFERENCES "public"."areas_of_focus"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "organisations_rels" ADD CONSTRAINT "organisations_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "organisations_tenant_idx" ON "organisations" USING btree ("tenant_id");
  CREATE INDEX "organisations_slug_idx" ON "organisations" USING btree ("slug");
  CREATE INDEX "organisations_type_idx" ON "organisations" USING btree ("type");
  CREATE INDEX "organisations_logo_idx" ON "organisations" USING btree ("logo_id");
  CREATE INDEX "organisations_cover_idx" ON "organisations" USING btree ("cover_id");
  CREATE INDEX "organisations_location_idx" ON "organisations" USING btree ("location_id");
  CREATE INDEX "organisations_legacy_id_idx" ON "organisations" USING btree ("legacy_id");
  CREATE INDEX "organisations_updated_at_idx" ON "organisations" USING btree ("updated_at");
  CREATE INDEX "organisations_created_at_idx" ON "organisations" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_slug_1_idx" ON "organisations" USING btree ("tenant_id","slug");
  CREATE INDEX "organisations_rels_order_idx" ON "organisations_rels" USING btree ("order");
  CREATE INDEX "organisations_rels_parent_idx" ON "organisations_rels" USING btree ("parent_id");
  CREATE INDEX "organisations_rels_path_idx" ON "organisations_rels" USING btree ("path");
  CREATE INDEX "organisations_rels_areas_of_focus_id_idx" ON "organisations_rels" USING btree ("areas_of_focus_id");
  CREATE INDEX "organisations_rels_users_id_idx" ON "organisations_rels" USING btree ("users_id");
  ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_organisations_fk" FOREIGN KEY ("organisations_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_organisation_idx" ON "users" USING btree ("organisation_id");
  CREATE UNIQUE INDEX "tenant_slug_2_idx" ON "job_categories" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_3_idx" ON "job_types" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_4_idx" ON "job_tags" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_5_idx" ON "salary_bands" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_6_idx" ON "areas_of_focus" USING btree ("tenant_id","slug");
  CREATE INDEX "payload_locked_documents_rels_organisations_id_idx" ON "payload_locked_documents_rels" USING btree ("organisations_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // The foreign keys, indexes and columns on other tables go before the tables. "DROP TABLE ...
  // CASCADE" takes "users_organisation_id_organisations_id_fk" with it, so dropping it again
  // afterwards fails.
  await db.execute(sql`
   ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_organisation_id_organisations_id_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_organisations_fk";
  DROP INDEX IF EXISTS "users_organisation_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_organisations_id_idx";
  ALTER TABLE "users" DROP COLUMN IF EXISTS "organisation_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "organisations_id";
  ALTER TABLE "organisations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "organisations_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "organisations" CASCADE;
  DROP TABLE "organisations_rels" CASCADE;

  DROP INDEX IF EXISTS "tenant_slug_1_idx";
  DROP INDEX IF EXISTS "tenant_slug_2_idx";
  DROP INDEX IF EXISTS "tenant_slug_3_idx";
  DROP INDEX IF EXISTS "tenant_slug_4_idx";
  DROP INDEX IF EXISTS "tenant_slug_5_idx";
  DROP INDEX IF EXISTS "tenant_slug_6_idx";
  CREATE UNIQUE INDEX "tenant_slug_1_idx" ON "job_categories" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_2_idx" ON "job_types" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_3_idx" ON "job_tags" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_4_idx" ON "salary_bands" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_5_idx" ON "areas_of_focus" USING btree ("tenant_id","slug");
  DROP TYPE IF EXISTS "public"."enum_organisations_type";
  DROP TYPE IF EXISTS "public"."enum_organisations_size";`)
}
