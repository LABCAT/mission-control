import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"title" varchar NOT NULL,
  	"legacy_id" numeric,
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
  
  CREATE TABLE "documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "media" ADD COLUMN "legacy_id" numeric;
  ALTER TABLE "media" ADD COLUMN "prefix" varchar DEFAULT '';
  ALTER TABLE "media" ADD COLUMN "_objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_avif__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w320_webp__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_avif__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w640_webp__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_avif__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w960_webp__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_avif__objectkey" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_url" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_width" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_height" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_mime_type" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_filesize" numeric;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_filename" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp_prefix" varchar;
  ALTER TABLE "media" ADD COLUMN "variants_w1280_webp__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_legacy_id" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_prefix" varchar DEFAULT '';
  ALTER TABLE "_media_v" ADD COLUMN "version__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_avif__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w320_webp__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_avif__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w640_webp__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_avif__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w960_webp__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_avif__objectkey" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_url" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_width" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_height" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_mime_type" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_filesize" numeric;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_filename" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp_prefix" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_variants_w1280_webp__objectkey" varchar;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "documents_id" integer;
  ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "documents_rels" ADD CONSTRAINT "documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "documents_rels" ADD CONSTRAINT "documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "documents_tenant_idx" ON "documents" USING btree ("tenant_id");
  CREATE INDEX "documents_legacy_id_idx" ON "documents" USING btree ("legacy_id");
  CREATE INDEX "documents_updated_at_idx" ON "documents" USING btree ("updated_at");
  CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");
  CREATE UNIQUE INDEX "documents_filename_idx" ON "documents" USING btree ("filename");
  CREATE INDEX "documents_original_original_filename_idx" ON "documents" USING btree ("original_filename");
  CREATE INDEX "documents_rels_order_idx" ON "documents_rels" USING btree ("order");
  CREATE INDEX "documents_rels_parent_idx" ON "documents_rels" USING btree ("parent_id");
  CREATE INDEX "documents_rels_path_idx" ON "documents_rels" USING btree ("path");
  CREATE INDEX "documents_rels_users_id_idx" ON "documents_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_documents_fk" FOREIGN KEY ("documents_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "media_legacy_id_idx" ON "media" USING btree ("legacy_id");
  CREATE INDEX "media_variants_w320_avif_variants_w320_avif_filename_idx" ON "media" USING btree ("variants_w320_avif_filename");
  CREATE INDEX "media_variants_w320_webp_variants_w320_webp_filename_idx" ON "media" USING btree ("variants_w320_webp_filename");
  CREATE INDEX "media_variants_w640_avif_variants_w640_avif_filename_idx" ON "media" USING btree ("variants_w640_avif_filename");
  CREATE INDEX "media_variants_w640_webp_variants_w640_webp_filename_idx" ON "media" USING btree ("variants_w640_webp_filename");
  CREATE INDEX "media_variants_w960_avif_variants_w960_avif_filename_idx" ON "media" USING btree ("variants_w960_avif_filename");
  CREATE INDEX "media_variants_w960_webp_variants_w960_webp_filename_idx" ON "media" USING btree ("variants_w960_webp_filename");
  CREATE INDEX "media_variants_w1280_avif_variants_w1280_avif_filename_idx" ON "media" USING btree ("variants_w1280_avif_filename");
  CREATE INDEX "media_variants_w1280_webp_variants_w1280_webp_filename_idx" ON "media" USING btree ("variants_w1280_webp_filename");
  CREATE INDEX "_media_v_version_version_legacy_id_idx" ON "_media_v" USING btree ("version_legacy_id");
  CREATE INDEX "_media_v_version_variants_w320_avif_version_variants_w32_idx" ON "_media_v" USING btree ("version_variants_w320_avif_filename");
  CREATE INDEX "_media_v_version_variants_w320_webp_version_variants_w32_idx" ON "_media_v" USING btree ("version_variants_w320_webp_filename");
  CREATE INDEX "_media_v_version_variants_w640_avif_version_variants_w64_idx" ON "_media_v" USING btree ("version_variants_w640_avif_filename");
  CREATE INDEX "_media_v_version_variants_w640_webp_version_variants_w64_idx" ON "_media_v" USING btree ("version_variants_w640_webp_filename");
  CREATE INDEX "_media_v_version_variants_w960_avif_version_variants_w96_idx" ON "_media_v" USING btree ("version_variants_w960_avif_filename");
  CREATE INDEX "_media_v_version_variants_w960_webp_version_variants_w96_idx" ON "_media_v" USING btree ("version_variants_w960_webp_filename");
  CREATE INDEX "_media_v_version_variants_w1280_avif_version_variants_w1_idx" ON "_media_v" USING btree ("version_variants_w1280_avif_filename");
  CREATE INDEX "_media_v_version_variants_w1280_webp_version_variants_w1_idx" ON "_media_v" USING btree ("version_variants_w1280_webp_filename");
  CREATE INDEX "payload_locked_documents_rels_documents_id_idx" ON "payload_locked_documents_rels" USING btree ("documents_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "documents_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "documents" CASCADE;
  DROP TABLE "documents_rels" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_documents_fk";
  
  DROP INDEX "media_legacy_id_idx";
  DROP INDEX "media_variants_w320_avif_variants_w320_avif_filename_idx";
  DROP INDEX "media_variants_w320_webp_variants_w320_webp_filename_idx";
  DROP INDEX "media_variants_w640_avif_variants_w640_avif_filename_idx";
  DROP INDEX "media_variants_w640_webp_variants_w640_webp_filename_idx";
  DROP INDEX "media_variants_w960_avif_variants_w960_avif_filename_idx";
  DROP INDEX "media_variants_w960_webp_variants_w960_webp_filename_idx";
  DROP INDEX "media_variants_w1280_avif_variants_w1280_avif_filename_idx";
  DROP INDEX "media_variants_w1280_webp_variants_w1280_webp_filename_idx";
  DROP INDEX "_media_v_version_version_legacy_id_idx";
  DROP INDEX "_media_v_version_variants_w320_avif_version_variants_w32_idx";
  DROP INDEX "_media_v_version_variants_w320_webp_version_variants_w32_idx";
  DROP INDEX "_media_v_version_variants_w640_avif_version_variants_w64_idx";
  DROP INDEX "_media_v_version_variants_w640_webp_version_variants_w64_idx";
  DROP INDEX "_media_v_version_variants_w960_avif_version_variants_w96_idx";
  DROP INDEX "_media_v_version_variants_w960_webp_version_variants_w96_idx";
  DROP INDEX "_media_v_version_variants_w1280_avif_version_variants_w1_idx";
  DROP INDEX "_media_v_version_variants_w1280_webp_version_variants_w1_idx";
  DROP INDEX "payload_locked_documents_rels_documents_id_idx";
  ALTER TABLE "media" DROP COLUMN "legacy_id";
  ALTER TABLE "media" DROP COLUMN "prefix";
  ALTER TABLE "media" DROP COLUMN "_objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_url";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_width";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_height";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w320_avif__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_url";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_width";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_height";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w320_webp__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_url";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_width";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_height";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w640_avif__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_url";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_width";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_height";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w640_webp__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_url";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_width";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_height";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w960_avif__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_url";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_width";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_height";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w960_webp__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_url";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_width";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_height";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_avif__objectkey";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_url";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_width";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_height";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_mime_type";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_filesize";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_filename";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp_prefix";
  ALTER TABLE "media" DROP COLUMN "variants_w1280_webp__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_legacy_id";
  ALTER TABLE "_media_v" DROP COLUMN "version_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_avif__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w320_webp__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_avif__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w640_webp__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_avif__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w960_webp__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_avif__objectkey";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_url";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_width";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_height";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_mime_type";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_filesize";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_filename";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp_prefix";
  ALTER TABLE "_media_v" DROP COLUMN "version_variants_w1280_webp__objectkey";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "documents_id";`)
}
