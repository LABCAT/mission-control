import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tenants_job_publication_moderation" AS ENUM('always', 'new-employers', 'never');
  CREATE TYPE "public"."enum_tenants_job_publication_trusted_go_live" AS ENUM('after-approval', 'after-payment', 'on-submit');
  CREATE TYPE "public"."enum_tenants_job_publication_new_employer_go_live" AS ENUM('after-approval', 'after-payment', 'on-submit');
  CREATE TYPE "public"."enum_jobs_log_event" AS ENUM('created', 'status');
  CREATE TYPE "public"."enum_jobs_log_actor" AS ENUM('employer', 'staff', 'system');
  CREATE TYPE "public"."enum_jobs_log_from" AS ENUM('draft', 'waiting_for_purchase', 'pending', 'published', 'expired', 'cancelled');
  CREATE TYPE "public"."enum_jobs_log_to" AS ENUM('draft', 'waiting_for_purchase', 'pending', 'published', 'expired', 'cancelled');
  ALTER TYPE "public"."enum_jobs_status" ADD VALUE 'waiting_for_purchase' BEFORE 'pending';
  CREATE TABLE "jobs_log" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"at" timestamp(3) with time zone NOT NULL,
  	"event" "enum_jobs_log_event" NOT NULL,
  	"actor" "enum_jobs_log_actor" NOT NULL,
  	"by_id" integer,
  	"from" "enum_jobs_log_from",
  	"to" "enum_jobs_log_to" NOT NULL,
  	"note" varchar
  );
  
  ALTER TABLE "tenants" ADD COLUMN "job_publication_moderation" "enum_tenants_job_publication_moderation" DEFAULT 'never';
  ALTER TABLE "tenants" ADD COLUMN "job_publication_trusted_go_live" "enum_tenants_job_publication_trusted_go_live" DEFAULT 'on-submit';
  ALTER TABLE "tenants" ADD COLUMN "job_publication_new_employer_go_live" "enum_tenants_job_publication_new_employer_go_live" DEFAULT 'after-approval';
  ALTER TABLE "tenants" ADD COLUMN "job_publication_trust_on_approval" boolean DEFAULT false;
  ALTER TABLE "organisations" ADD COLUMN "trusted" boolean DEFAULT false;
  ALTER TABLE "jobs_log" ADD CONSTRAINT "jobs_log_by_id_users_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "jobs_log" ADD CONSTRAINT "jobs_log_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "jobs_log_order_idx" ON "jobs_log" USING btree ("_order");
  CREATE INDEX "jobs_log_parent_id_idx" ON "jobs_log" USING btree ("_parent_id");
  CREATE INDEX "jobs_log_by_idx" ON "jobs_log" USING btree ("by_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "jobs_log" CASCADE;
  ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE text;
  ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'draft'::text;
  DROP TYPE "public"."enum_jobs_status";
  CREATE TYPE "public"."enum_jobs_status" AS ENUM('draft', 'pending', 'published', 'expired', 'cancelled');
  ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."enum_jobs_status";
  ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE "public"."enum_jobs_status" USING "status"::"public"."enum_jobs_status";
  ALTER TABLE "tenants" DROP COLUMN "job_publication_moderation";
  ALTER TABLE "tenants" DROP COLUMN "job_publication_trusted_go_live";
  ALTER TABLE "tenants" DROP COLUMN "job_publication_new_employer_go_live";
  ALTER TABLE "tenants" DROP COLUMN "job_publication_trust_on_approval";
  ALTER TABLE "organisations" DROP COLUMN "trusted";
  DROP TYPE "public"."enum_tenants_job_publication_moderation";
  DROP TYPE "public"."enum_tenants_job_publication_trusted_go_live";
  DROP TYPE "public"."enum_tenants_job_publication_new_employer_go_live";
  DROP TYPE "public"."enum_jobs_log_event";
  DROP TYPE "public"."enum_jobs_log_actor";
  DROP TYPE "public"."enum_jobs_log_from";
  DROP TYPE "public"."enum_jobs_log_to";`)
}
