import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "alert_subscriptions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"email" varchar NOT NULL,
  	"confirmed" boolean DEFAULT false,
  	"confirm_token" varchar,
  	"manage_token" varchar,
  	"keywords" varchar,
  	"last_sent_at" timestamp(3) with time zone,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "alert_subscriptions_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"job_categories_id" integer,
  	"job_types_id" integer,
  	"locations_id" integer,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "alert_subscriptions_id" integer;
  ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "alert_subscriptions_rels" ADD CONSTRAINT "alert_subscriptions_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."alert_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "alert_subscriptions_rels" ADD CONSTRAINT "alert_subscriptions_rels_job_categories_fk" FOREIGN KEY ("job_categories_id") REFERENCES "public"."job_categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "alert_subscriptions_rels" ADD CONSTRAINT "alert_subscriptions_rels_job_types_fk" FOREIGN KEY ("job_types_id") REFERENCES "public"."job_types"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "alert_subscriptions_rels" ADD CONSTRAINT "alert_subscriptions_rels_locations_fk" FOREIGN KEY ("locations_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "alert_subscriptions_rels" ADD CONSTRAINT "alert_subscriptions_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "alert_subscriptions_tenant_idx" ON "alert_subscriptions" USING btree ("tenant_id");
  CREATE INDEX "alert_subscriptions_confirmed_idx" ON "alert_subscriptions" USING btree ("confirmed");
  CREATE UNIQUE INDEX "alert_subscriptions_confirm_token_idx" ON "alert_subscriptions" USING btree ("confirm_token");
  CREATE UNIQUE INDEX "alert_subscriptions_manage_token_idx" ON "alert_subscriptions" USING btree ("manage_token");
  CREATE INDEX "alert_subscriptions_legacy_id_idx" ON "alert_subscriptions" USING btree ("legacy_id");
  CREATE INDEX "alert_subscriptions_updated_at_idx" ON "alert_subscriptions" USING btree ("updated_at");
  CREATE INDEX "alert_subscriptions_created_at_idx" ON "alert_subscriptions" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_email_idx" ON "alert_subscriptions" USING btree ("tenant_id","email");
  CREATE INDEX "alert_subscriptions_rels_order_idx" ON "alert_subscriptions_rels" USING btree ("order");
  CREATE INDEX "alert_subscriptions_rels_parent_idx" ON "alert_subscriptions_rels" USING btree ("parent_id");
  CREATE INDEX "alert_subscriptions_rels_path_idx" ON "alert_subscriptions_rels" USING btree ("path");
  CREATE INDEX "alert_subscriptions_rels_job_categories_id_idx" ON "alert_subscriptions_rels" USING btree ("job_categories_id");
  CREATE INDEX "alert_subscriptions_rels_job_types_id_idx" ON "alert_subscriptions_rels" USING btree ("job_types_id");
  CREATE INDEX "alert_subscriptions_rels_locations_id_idx" ON "alert_subscriptions_rels" USING btree ("locations_id");
  CREATE INDEX "alert_subscriptions_rels_users_id_idx" ON "alert_subscriptions_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_alert_subscriptions_fk" FOREIGN KEY ("alert_subscriptions_id") REFERENCES "public"."alert_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_alert_subscriptions_id_idx" ON "payload_locked_documents_rels" USING btree ("alert_subscriptions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "alert_subscriptions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "alert_subscriptions_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_alert_subscriptions_fk";
  DROP TABLE "alert_subscriptions" CASCADE;
  DROP TABLE "alert_subscriptions_rels" CASCADE;
  DROP INDEX IF EXISTS "payload_locked_documents_rels_alert_subscriptions_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "alert_subscriptions_id";`)
}
