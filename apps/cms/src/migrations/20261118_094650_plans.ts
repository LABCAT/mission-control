import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_plans_status" AS ENUM('active', 'archived');
  CREATE TABLE "plans" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"key" varchar NOT NULL,
  	"price" numeric NOT NULL,
  	"currency" varchar,
  	"duration_days" numeric NOT NULL,
  	"job_credits" numeric DEFAULT 1 NOT NULL,
  	"credit_expiry_days" numeric,
  	"accepts_credits" boolean DEFAULT true,
  	"is_volunteer" boolean DEFAULT false,
  	"status" "enum_plans_status" DEFAULT 'active' NOT NULL,
  	"sort_order" numeric DEFAULT 0,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "plans_locales" (
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" integer NOT NULL
  );
  
  CREATE TABLE "plans_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "plans_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "plans_id" integer;
  ALTER TABLE "plans" ADD CONSTRAINT "plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "plans_locales" ADD CONSTRAINT "plans_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "plans_texts" ADD CONSTRAINT "plans_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "plans_rels" ADD CONSTRAINT "plans_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "plans_rels" ADD CONSTRAINT "plans_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "plans_tenant_idx" ON "plans" USING btree ("tenant_id");
  CREATE INDEX "plans_key_idx" ON "plans" USING btree ("key");
  CREATE INDEX "plans_status_idx" ON "plans" USING btree ("status");
  CREATE INDEX "plans_legacy_id_idx" ON "plans" USING btree ("legacy_id");
  CREATE INDEX "plans_updated_at_idx" ON "plans" USING btree ("updated_at");
  CREATE INDEX "plans_created_at_idx" ON "plans" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_key_idx" ON "plans" USING btree ("tenant_id","key");
  CREATE UNIQUE INDEX "plans_locales_parent_id_locale_unique" ON "plans_locales" USING btree ("_parent_id","_locale");
  CREATE INDEX "plans_texts_order_parent" ON "plans_texts" USING btree ("order","parent_id");
  CREATE INDEX "plans_rels_order_idx" ON "plans_rels" USING btree ("order");
  CREATE INDEX "plans_rels_parent_idx" ON "plans_rels" USING btree ("parent_id");
  CREATE INDEX "plans_rels_path_idx" ON "plans_rels" USING btree ("path");
  CREATE INDEX "plans_rels_users_id_idx" ON "plans_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_plans_fk" FOREIGN KEY ("plans_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_plans_id_idx" ON "payload_locked_documents_rels" USING btree ("plans_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "plans" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "plans_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "plans_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "plans_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_plans_fk";
  DROP TABLE "plans" CASCADE;
  DROP TABLE "plans_locales" CASCADE;
  DROP TABLE "plans_texts" CASCADE;
  DROP TABLE "plans_rels" CASCADE;
  DROP INDEX IF EXISTS "payload_locked_documents_rels_plans_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "plans_id";
  DROP TYPE IF EXISTS "public"."enum_plans_status";`)
}
