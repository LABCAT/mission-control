import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "site_settings_blocks_banner" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"desktop_image_id" integer NOT NULL,
  	"mobile_image_id" integer,
  	"alt" varchar,
  	"href" varchar,
  	"new_tab" boolean DEFAULT false,
  	"priority" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "site_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"site_name" varchar,
  	"logo_id" integer,
  	"tagline" varchar,
  	"footer_text" varchar,
  	"lang" varchar DEFAULT 'en',
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_settings_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  DROP INDEX "tenant_idx";
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "site_settings_id" integer;
  ALTER TABLE "site_settings_blocks_banner" ADD CONSTRAINT "site_settings_blocks_banner_desktop_image_id_media_id_fk" FOREIGN KEY ("desktop_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_settings_blocks_banner" ADD CONSTRAINT "site_settings_blocks_banner_mobile_image_id_media_id_fk" FOREIGN KEY ("mobile_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_settings_blocks_banner" ADD CONSTRAINT "site_settings_blocks_banner_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_logo_id_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_settings_rels" ADD CONSTRAINT "site_settings_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings_rels" ADD CONSTRAINT "site_settings_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "site_settings_blocks_banner_order_idx" ON "site_settings_blocks_banner" USING btree ("_order");
  CREATE INDEX "site_settings_blocks_banner_parent_id_idx" ON "site_settings_blocks_banner" USING btree ("_parent_id");
  CREATE INDEX "site_settings_blocks_banner_path_idx" ON "site_settings_blocks_banner" USING btree ("_path");
  CREATE INDEX "site_settings_blocks_banner_desktop_image_idx" ON "site_settings_blocks_banner" USING btree ("desktop_image_id");
  CREATE INDEX "site_settings_blocks_banner_mobile_image_idx" ON "site_settings_blocks_banner" USING btree ("mobile_image_id");
  CREATE UNIQUE INDEX "site_settings_tenant_idx" ON "site_settings" USING btree ("tenant_id");
  CREATE INDEX "site_settings_logo_idx" ON "site_settings" USING btree ("logo_id");
  CREATE INDEX "site_settings_legacy_id_idx" ON "site_settings" USING btree ("legacy_id");
  CREATE INDEX "site_settings_updated_at_idx" ON "site_settings" USING btree ("updated_at");
  CREATE INDEX "site_settings_created_at_idx" ON "site_settings" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_idx" ON "site_settings" USING btree ("tenant_id");
  CREATE INDEX "site_settings_rels_order_idx" ON "site_settings_rels" USING btree ("order");
  CREATE INDEX "site_settings_rels_parent_idx" ON "site_settings_rels" USING btree ("parent_id");
  CREATE INDEX "site_settings_rels_path_idx" ON "site_settings_rels" USING btree ("path");
  CREATE INDEX "site_settings_rels_users_id_idx" ON "site_settings_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_settings_fk" FOREIGN KEY ("site_settings_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "tenant_1_idx" ON "xero_settings" USING btree ("tenant_id");
  CREATE INDEX "payload_locked_documents_rels_site_settings_id_idx" ON "payload_locked_documents_rels" USING btree ("site_settings_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_site_settings_fk";
  ALTER TABLE "site_settings_blocks_banner" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_settings" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_settings_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "site_settings_blocks_banner" CASCADE;
  DROP TABLE "site_settings" CASCADE;
  DROP TABLE "site_settings_rels" CASCADE;
  
  DROP INDEX "tenant_1_idx";
  DROP INDEX "payload_locked_documents_rels_site_settings_id_idx";
  CREATE UNIQUE INDEX "tenant_idx" ON "xero_settings" USING btree ("tenant_id");
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "site_settings_id";`)
}
