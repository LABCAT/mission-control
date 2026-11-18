import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_email_templates_key" AS ENUM('new_user', 'new_user_admin', 'resend_confirmation', 'new_job_admin', 'new_job', 'job_approved', 'job_expiring', 'expired_job', 'job_canceled', 'new_order', 'order_complete', 'new_application', 'application_received', 'organisation_listing_request', 'organisation_live', 'contact_form', 'alert_confirm', 'job_alerts_digest');
  CREATE TABLE "email_templates" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"key" "enum_email_templates_key" NOT NULL,
  	"subject" varchar NOT NULL,
  	"body" varchar NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "email_templates_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "email_templates_id" integer;
  ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "email_templates_rels" ADD CONSTRAINT "email_templates_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."email_templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "email_templates_rels" ADD CONSTRAINT "email_templates_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "email_templates_tenant_idx" ON "email_templates" USING btree ("tenant_id");
  CREATE INDEX "email_templates_key_idx" ON "email_templates" USING btree ("key");
  CREATE INDEX "email_templates_updated_at_idx" ON "email_templates" USING btree ("updated_at");
  CREATE INDEX "email_templates_created_at_idx" ON "email_templates" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_key_1_idx" ON "email_templates" USING btree ("tenant_id","key");
  CREATE INDEX "email_templates_rels_order_idx" ON "email_templates_rels" USING btree ("order");
  CREATE INDEX "email_templates_rels_parent_idx" ON "email_templates_rels" USING btree ("parent_id");
  CREATE INDEX "email_templates_rels_path_idx" ON "email_templates_rels" USING btree ("path");
  CREATE INDEX "email_templates_rels_users_id_idx" ON "email_templates_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_email_templates_fk" FOREIGN KEY ("email_templates_id") REFERENCES "public"."email_templates"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_email_templates_id_idx" ON "payload_locked_documents_rels" USING btree ("email_templates_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "email_templates" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "email_templates_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_email_templates_fk";
  DROP TABLE "email_templates" CASCADE;
  DROP TABLE "email_templates_rels" CASCADE;
  DROP INDEX IF EXISTS "payload_locked_documents_rels_email_templates_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "email_templates_id";
  DROP TYPE IF EXISTS "public"."enum_email_templates_key";`)
}
