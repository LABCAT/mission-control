import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tenants_expired_job_mode" AS ENUM('notice', 'gone');
  CREATE TABLE "jobs_view_days" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"day" varchar NOT NULL,
  	"count" numeric NOT NULL
  );
  
  ALTER TABLE "tenants" ADD COLUMN "expired_job_mode" "enum_tenants_expired_job_mode" DEFAULT 'notice';
  ALTER TABLE "tenants" ADD COLUMN "expired_job_gone_after_months" numeric DEFAULT 12;
  ALTER TABLE "tenants" ADD COLUMN "public_job_views" boolean DEFAULT false;
  ALTER TABLE "jobs_view_days" ADD CONSTRAINT "jobs_view_days_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "jobs_view_days_order_idx" ON "jobs_view_days" USING btree ("_order");
  CREATE INDEX "jobs_view_days_parent_id_idx" ON "jobs_view_days" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "jobs_view_days" CASCADE;
  ALTER TABLE "tenants" DROP COLUMN "expired_job_mode";
  ALTER TABLE "tenants" DROP COLUMN "expired_job_gone_after_months";
  ALTER TABLE "tenants" DROP COLUMN "public_job_views";
  DROP TYPE "public"."enum_tenants_expired_job_mode";`)
}
