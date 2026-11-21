import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_credit_ledger_reason" AS ENUM('bought', 'used', 'refunded', 'adjustment', 'opening');
  CREATE TYPE "public"."enum_credit_ledger_actor" AS ENUM('system', 'staff');
  CREATE TABLE "credit_ledger" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"organisation_id" integer NOT NULL,
  	"delta" numeric NOT NULL,
  	"reason" "enum_credit_ledger_reason" DEFAULT 'adjustment' NOT NULL,
  	"note" varchar,
  	"order_id" integer,
  	"job_id" integer,
  	"actor" "enum_credit_ledger_actor",
  	"legacy_ref" varchar,
  	"idempotency_key" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "credit_ledger_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "credit_ledger_id" integer;
  ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "credit_ledger_rels" ADD CONSTRAINT "credit_ledger_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."credit_ledger"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "credit_ledger_rels" ADD CONSTRAINT "credit_ledger_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "credit_ledger_tenant_idx" ON "credit_ledger" USING btree ("tenant_id");
  CREATE INDEX "credit_ledger_organisation_idx" ON "credit_ledger" USING btree ("organisation_id");
  CREATE INDEX "credit_ledger_reason_idx" ON "credit_ledger" USING btree ("reason");
  CREATE INDEX "credit_ledger_order_idx" ON "credit_ledger" USING btree ("order_id");
  CREATE INDEX "credit_ledger_job_idx" ON "credit_ledger" USING btree ("job_id");
  CREATE INDEX "credit_ledger_legacy_ref_idx" ON "credit_ledger" USING btree ("legacy_ref");
  CREATE UNIQUE INDEX "credit_ledger_idempotency_key_idx" ON "credit_ledger" USING btree ("idempotency_key");
  CREATE INDEX "credit_ledger_updated_at_idx" ON "credit_ledger" USING btree ("updated_at");
  CREATE INDEX "credit_ledger_created_at_idx" ON "credit_ledger" USING btree ("created_at");
  CREATE INDEX "credit_ledger_rels_order_idx" ON "credit_ledger_rels" USING btree ("order");
  CREATE INDEX "credit_ledger_rels_parent_idx" ON "credit_ledger_rels" USING btree ("parent_id");
  CREATE INDEX "credit_ledger_rels_path_idx" ON "credit_ledger_rels" USING btree ("path");
  CREATE INDEX "credit_ledger_rels_users_id_idx" ON "credit_ledger_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_credit_ledger_fk" FOREIGN KEY ("credit_ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_credit_ledger_id_idx" ON "payload_locked_documents_rels" USING btree ("credit_ledger_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "credit_ledger" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "credit_ledger_rels" DISABLE ROW LEVEL SECURITY;
  -- mission-control: drop the foreign key into "credit_ledger" first; DROP TABLE ... CASCADE
  -- removes it, and the generated order then failed on the explicit DROP CONSTRAINT.
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_credit_ledger_fk";
  DROP TABLE "credit_ledger" CASCADE;
  DROP TABLE "credit_ledger_rels" CASCADE;
  DROP INDEX "payload_locked_documents_rels_credit_ledger_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "credit_ledger_id";
  DROP TYPE "public"."enum_credit_ledger_reason";
  DROP TYPE "public"."enum_credit_ledger_actor";`)
}
