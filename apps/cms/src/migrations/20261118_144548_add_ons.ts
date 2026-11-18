import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_add_ons_placement" AS ENUM('featured-in-listings', 'featured-in-category');
  CREATE TABLE "plans_included_add_ons" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"add_on_id" integer NOT NULL,
  	"duration_days" numeric
  );
  
  CREATE TABLE "add_ons_grants" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"add_on_id" integer NOT NULL,
  	"duration_days" numeric NOT NULL
  );
  
  CREATE TABLE "add_ons" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"key" varchar NOT NULL,
  	"price" numeric NOT NULL,
  	"currency" varchar,
  	"duration_days" numeric NOT NULL,
  	"placement" "enum_add_ons_placement" NOT NULL,
  	"active" boolean DEFAULT true,
  	"sort_order" numeric DEFAULT 0,
  	"legacy_id" numeric,
  	"legacy_key" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "add_ons_locales" (
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "add_ons_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "add_ons_id" integer;
  ALTER TABLE "plans_included_add_ons" ADD CONSTRAINT "plans_included_add_ons_add_on_id_add_ons_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_ons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "plans_included_add_ons" ADD CONSTRAINT "plans_included_add_ons_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "add_ons_grants" ADD CONSTRAINT "add_ons_grants_add_on_id_add_ons_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_ons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "add_ons_grants" ADD CONSTRAINT "add_ons_grants_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."add_ons"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "add_ons" ADD CONSTRAINT "add_ons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "add_ons_locales" ADD CONSTRAINT "add_ons_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."add_ons"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "add_ons_rels" ADD CONSTRAINT "add_ons_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."add_ons"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "add_ons_rels" ADD CONSTRAINT "add_ons_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "plans_included_add_ons_order_idx" ON "plans_included_add_ons" USING btree ("_order");
  CREATE INDEX "plans_included_add_ons_parent_id_idx" ON "plans_included_add_ons" USING btree ("_parent_id");
  CREATE INDEX "plans_included_add_ons_add_on_idx" ON "plans_included_add_ons" USING btree ("add_on_id");
  CREATE INDEX "add_ons_grants_order_idx" ON "add_ons_grants" USING btree ("_order");
  CREATE INDEX "add_ons_grants_parent_id_idx" ON "add_ons_grants" USING btree ("_parent_id");
  CREATE INDEX "add_ons_grants_add_on_idx" ON "add_ons_grants" USING btree ("add_on_id");
  CREATE INDEX "add_ons_tenant_idx" ON "add_ons" USING btree ("tenant_id");
  CREATE INDEX "add_ons_key_idx" ON "add_ons" USING btree ("key");
  CREATE INDEX "add_ons_active_idx" ON "add_ons" USING btree ("active");
  CREATE INDEX "add_ons_legacy_id_idx" ON "add_ons" USING btree ("legacy_id");
  CREATE INDEX "add_ons_legacy_key_idx" ON "add_ons" USING btree ("legacy_key");
  CREATE INDEX "add_ons_updated_at_idx" ON "add_ons" USING btree ("updated_at");
  CREATE INDEX "add_ons_created_at_idx" ON "add_ons" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_key_1_idx" ON "add_ons" USING btree ("tenant_id","key");
  CREATE UNIQUE INDEX "add_ons_locales_parent_id_locale_unique" ON "add_ons_locales" USING btree ("_parent_id","_locale");
  CREATE INDEX "add_ons_rels_order_idx" ON "add_ons_rels" USING btree ("order");
  CREATE INDEX "add_ons_rels_parent_idx" ON "add_ons_rels" USING btree ("parent_id");
  CREATE INDEX "add_ons_rels_path_idx" ON "add_ons_rels" USING btree ("path");
  CREATE INDEX "add_ons_rels_users_id_idx" ON "add_ons_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_add_ons_fk" FOREIGN KEY ("add_ons_id") REFERENCES "public"."add_ons"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_add_ons_id_idx" ON "payload_locked_documents_rels" USING btree ("add_ons_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "plans_included_add_ons" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "add_ons_grants" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "add_ons" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "add_ons_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "add_ons_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_add_ons_fk";
  DROP TABLE "plans_included_add_ons" CASCADE;
  DROP TABLE "add_ons_grants" CASCADE;
  DROP TABLE "add_ons" CASCADE;
  DROP TABLE "add_ons_locales" CASCADE;
  DROP TABLE "add_ons_rels" CASCADE;
  DROP INDEX IF EXISTS "payload_locked_documents_rels_add_ons_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "add_ons_id";
  DROP TYPE IF EXISTS "public"."enum_add_ons_placement";`)
}
