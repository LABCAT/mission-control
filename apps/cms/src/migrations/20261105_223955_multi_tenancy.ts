import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_tenants_role" AS ENUM('tenant-admin', 'editor', 'employer');
  CREATE TYPE "public"."enum_users_role" AS ENUM('super-admin', 'user');
  CREATE TABLE "users_tenants" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"tenant_id" integer NOT NULL,
  	"role" "enum_users_tenants_role" NOT NULL
  );
  
  CREATE TABLE "tenants_domains" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"domain" varchar NOT NULL
  );
  
  CREATE TABLE "tenants_locales" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"locale" varchar NOT NULL
  );
  
  CREATE TABLE "tenants" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"is_aggregate" boolean DEFAULT false,
  	"currency" varchar NOT NULL,
  	"currency_minor_units" numeric NOT NULL,
  	"timezone" varchar NOT NULL,
  	"default_locale" varchar NOT NULL,
  	"tax_label" varchar NOT NULL,
  	"email_from_name" varchar NOT NULL,
  	"email_from_address" varchar NOT NULL,
  	"admin_email" varchar NOT NULL,
  	"branding_logo_id" integer,
  	"branding_color_primary" varchar NOT NULL,
  	"branding_color_accent" varchar NOT NULL,
  	"branding_color_hover" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "tenants_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "users" ADD COLUMN "role" "enum_users_role" DEFAULT 'user' NOT NULL;
  UPDATE "users" SET "role" = 'super-admin' WHERE "id" = (SELECT MIN("id") FROM "users");
  ALTER TABLE "media" ADD COLUMN "tenant_id" integer;
  ALTER TABLE "_media_v" ADD COLUMN "version_tenant_id" integer;
  ALTER TABLE "folders" ADD COLUMN "tenant_id" integer;
  ALTER TABLE "_folders_v" ADD COLUMN "version_tenant_id" integer;
  ALTER TABLE "tags" ADD COLUMN "tenant_id" integer;
  ALTER TABLE "_tags_v" ADD COLUMN "version_tenant_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "tenants_id" integer;
  ALTER TABLE "users_tenants" ADD CONSTRAINT "users_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "users_tenants" ADD CONSTRAINT "users_tenants_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_domains" ADD CONSTRAINT "tenants_domains_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_locales" ADD CONSTRAINT "tenants_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants" ADD CONSTRAINT "tenants_branding_logo_id_media_id_fk" FOREIGN KEY ("branding_logo_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tenants_rels" ADD CONSTRAINT "tenants_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tenants_rels" ADD CONSTRAINT "tenants_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_tenants_order_idx" ON "users_tenants" USING btree ("_order");
  CREATE INDEX "users_tenants_parent_id_idx" ON "users_tenants" USING btree ("_parent_id");
  CREATE INDEX "users_tenants_tenant_idx" ON "users_tenants" USING btree ("tenant_id");
  CREATE INDEX "tenants_domains_order_idx" ON "tenants_domains" USING btree ("_order");
  CREATE INDEX "tenants_domains_parent_id_idx" ON "tenants_domains" USING btree ("_parent_id");
  CREATE INDEX "tenants_locales_order_idx" ON "tenants_locales" USING btree ("_order");
  CREATE INDEX "tenants_locales_parent_id_idx" ON "tenants_locales" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");
  CREATE INDEX "tenants_branding_branding_logo_idx" ON "tenants" USING btree ("branding_logo_id");
  CREATE INDEX "tenants_updated_at_idx" ON "tenants" USING btree ("updated_at");
  CREATE INDEX "tenants_created_at_idx" ON "tenants" USING btree ("created_at");
  CREATE INDEX "tenants_rels_order_idx" ON "tenants_rels" USING btree ("order");
  CREATE INDEX "tenants_rels_parent_idx" ON "tenants_rels" USING btree ("parent_id");
  CREATE INDEX "tenants_rels_path_idx" ON "tenants_rels" USING btree ("path");
  CREATE INDEX "tenants_rels_users_id_idx" ON "tenants_rels" USING btree ("users_id");
  ALTER TABLE "media" ADD CONSTRAINT "media_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_media_v" ADD CONSTRAINT "_media_v_version_tenant_id_tenants_id_fk" FOREIGN KEY ("version_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "folders" ADD CONSTRAINT "folders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_folders_v" ADD CONSTRAINT "_folders_v_version_tenant_id_tenants_id_fk" FOREIGN KEY ("version_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_tags_v" ADD CONSTRAINT "_tags_v_version_tenant_id_tenants_id_fk" FOREIGN KEY ("version_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tenants_fk" FOREIGN KEY ("tenants_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "media_tenant_idx" ON "media" USING btree ("tenant_id");
  CREATE INDEX "_media_v_version_version_tenant_idx" ON "_media_v" USING btree ("version_tenant_id");
  CREATE INDEX "folders_tenant_idx" ON "folders" USING btree ("tenant_id");
  CREATE INDEX "_folders_v_version_version_tenant_idx" ON "_folders_v" USING btree ("version_tenant_id");
  CREATE INDEX "tags_tenant_idx" ON "tags" USING btree ("tenant_id");
  CREATE INDEX "_tags_v_version_version_tenant_idx" ON "_tags_v" USING btree ("version_tenant_id");
  CREATE INDEX "payload_locked_documents_rels_tenants_id_idx" ON "payload_locked_documents_rels" USING btree ("tenants_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users_tenants" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tenants_domains" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tenants_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tenants" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tenants_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "users_tenants" CASCADE;
  DROP TABLE "tenants_domains" CASCADE;
  DROP TABLE "tenants_locales" CASCADE;
  DROP TABLE "tenants" CASCADE;
  DROP TABLE "tenants_rels" CASCADE;
  DROP INDEX "media_tenant_idx";
  DROP INDEX "_media_v_version_version_tenant_idx";
  DROP INDEX "folders_tenant_idx";
  DROP INDEX "_folders_v_version_version_tenant_idx";
  DROP INDEX "tags_tenant_idx";
  DROP INDEX "_tags_v_version_version_tenant_idx";
  DROP INDEX "payload_locked_documents_rels_tenants_id_idx";
  ALTER TABLE "users" DROP COLUMN "role";
  ALTER TABLE "media" DROP COLUMN "tenant_id";
  ALTER TABLE "_media_v" DROP COLUMN "version_tenant_id";
  ALTER TABLE "folders" DROP COLUMN "tenant_id";
  ALTER TABLE "_folders_v" DROP COLUMN "version_tenant_id";
  ALTER TABLE "tags" DROP COLUMN "tenant_id";
  ALTER TABLE "_tags_v" DROP COLUMN "version_tenant_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "tenants_id";
  DROP TYPE "public"."enum_users_tenants_role";
  DROP TYPE "public"."enum_users_role";`)
}
