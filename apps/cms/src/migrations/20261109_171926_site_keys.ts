import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "site_keys" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"tenant_id" integer NOT NULL,
  	"key_hash" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_keys_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "site_keys_id" integer;
  ALTER TABLE "site_keys" ADD CONSTRAINT "site_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_keys_rels" ADD CONSTRAINT "site_keys_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."site_keys"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_keys_rels" ADD CONSTRAINT "site_keys_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "site_keys_tenant_idx" ON "site_keys" USING btree ("tenant_id");
  CREATE UNIQUE INDEX "site_keys_key_hash_idx" ON "site_keys" USING btree ("key_hash");
  CREATE INDEX "site_keys_updated_at_idx" ON "site_keys" USING btree ("updated_at");
  CREATE INDEX "site_keys_created_at_idx" ON "site_keys" USING btree ("created_at");
  CREATE INDEX "site_keys_rels_order_idx" ON "site_keys_rels" USING btree ("order");
  CREATE INDEX "site_keys_rels_parent_idx" ON "site_keys_rels" USING btree ("parent_id");
  CREATE INDEX "site_keys_rels_path_idx" ON "site_keys_rels" USING btree ("path");
  CREATE INDEX "site_keys_rels_users_id_idx" ON "site_keys_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_keys_fk" FOREIGN KEY ("site_keys_id") REFERENCES "public"."site_keys"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_site_keys_id_idx" ON "payload_locked_documents_rels" USING btree ("site_keys_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "site_keys" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_keys_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_site_keys_fk";
  DROP TABLE "site_keys" CASCADE;
  DROP TABLE "site_keys_rels" CASCADE;
  DROP INDEX IF EXISTS "payload_locked_documents_rels_site_keys_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "site_keys_id";`)
}
