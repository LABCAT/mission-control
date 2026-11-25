import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants" ADD COLUMN "allow_ai_crawlers" boolean DEFAULT true;
  ALTER TABLE "organisations" ADD COLUMN "seo_title" varchar;
  ALTER TABLE "organisations" ADD COLUMN "seo_description" varchar;
  ALTER TABLE "organisations" ADD COLUMN "seo_image_id" integer;
  ALTER TABLE "organisations" ADD COLUMN "seo_no_index" boolean DEFAULT false;
  ALTER TABLE "jobs" ADD COLUMN "seo_title" varchar;
  ALTER TABLE "jobs" ADD COLUMN "seo_description" varchar;
  ALTER TABLE "jobs" ADD COLUMN "seo_no_index" boolean DEFAULT false;
  ALTER TABLE "organisations" ADD CONSTRAINT "organisations_seo_image_id_media_id_fk" FOREIGN KEY ("seo_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "organisations_seo_seo_image_idx" ON "organisations" USING btree ("seo_image_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "organisations" DROP CONSTRAINT "organisations_seo_image_id_media_id_fk";
  
  DROP INDEX "organisations_seo_seo_image_idx";
  ALTER TABLE "tenants" DROP COLUMN "allow_ai_crawlers";
  ALTER TABLE "organisations" DROP COLUMN "seo_title";
  ALTER TABLE "organisations" DROP COLUMN "seo_description";
  ALTER TABLE "organisations" DROP COLUMN "seo_image_id";
  ALTER TABLE "organisations" DROP COLUMN "seo_no_index";
  ALTER TABLE "jobs" DROP COLUMN "seo_title";
  ALTER TABLE "jobs" DROP COLUMN "seo_description";
  ALTER TABLE "jobs" DROP COLUMN "seo_no_index";`)
}
