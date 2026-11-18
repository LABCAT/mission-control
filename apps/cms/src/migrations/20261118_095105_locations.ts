import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_locations_kind" AS ENUM('region', 'island', 'town');
  CREATE TABLE "locations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"kind" "enum_locations_kind" NOT NULL,
  	"parent_id" integer,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "locations_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  DROP INDEX "tenant_slug_idx";
  DROP INDEX "tenant_slug_1_idx";
  DROP INDEX "tenant_slug_2_idx";
  DROP INDEX "tenant_slug_3_idx";
  DROP INDEX "tenant_slug_4_idx";
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "locations_id" integer;
  ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "locations_rels" ADD CONSTRAINT "locations_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "locations_rels" ADD CONSTRAINT "locations_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "locations_tenant_idx" ON "locations" USING btree ("tenant_id");
  CREATE INDEX "locations_slug_idx" ON "locations" USING btree ("slug");
  CREATE INDEX "locations_parent_idx" ON "locations" USING btree ("parent_id");
  CREATE INDEX "locations_legacy_id_idx" ON "locations" USING btree ("legacy_id");
  CREATE INDEX "locations_updated_at_idx" ON "locations" USING btree ("updated_at");
  CREATE INDEX "locations_created_at_idx" ON "locations" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_slug_idx" ON "locations" USING btree ("tenant_id","slug");
  CREATE INDEX "locations_rels_order_idx" ON "locations_rels" USING btree ("order");
  CREATE INDEX "locations_rels_parent_idx" ON "locations_rels" USING btree ("parent_id");
  CREATE INDEX "locations_rels_path_idx" ON "locations_rels" USING btree ("path");
  CREATE INDEX "locations_rels_users_id_idx" ON "locations_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_locations_fk" FOREIGN KEY ("locations_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "tenant_slug_1_idx" ON "job_categories" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_2_idx" ON "job_types" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_3_idx" ON "job_tags" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_4_idx" ON "salary_bands" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_5_idx" ON "areas_of_focus" USING btree ("tenant_id","slug");
  CREATE INDEX "payload_locked_documents_rels_locations_id_idx" ON "payload_locked_documents_rels" USING btree ("locations_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // The foreign key, index and column go before the tables. "DROP TABLE ... CASCADE" takes
  // the constraint and the index with them, so dropping them again afterwards fails.
  await db.execute(sql`
   ALTER TABLE "locations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "locations_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_locations_fk";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_locations_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "locations_id";
  DROP TABLE "locations" CASCADE;
  DROP TABLE "locations_rels" CASCADE;

  DROP INDEX "tenant_slug_1_idx";
  DROP INDEX "tenant_slug_2_idx";
  DROP INDEX "tenant_slug_3_idx";
  DROP INDEX "tenant_slug_4_idx";
  DROP INDEX "tenant_slug_5_idx";
  CREATE UNIQUE INDEX "tenant_slug_idx" ON "job_categories" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_1_idx" ON "job_types" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_2_idx" ON "job_tags" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_3_idx" ON "salary_bands" USING btree ("tenant_id","slug");
  CREATE UNIQUE INDEX "tenant_slug_4_idx" ON "areas_of_focus" USING btree ("tenant_id","slug");
  DROP TYPE "public"."enum_locations_kind";`)
}
