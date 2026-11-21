import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_orders_log_event" AS ENUM('created', 'status', 'external-ref', 'jobs', 'organisation', 'paid-at');
  CREATE TYPE "public"."enum_orders_log_actor" AS ENUM('system', 'staff', 'owner', 'member');
  CREATE TYPE "public"."enum_orders_status" AS ENUM('waiting_for_purchase', 'pending', 'invoiced', 'paid', 'cancelled', 'failed');
  CREATE TYPE "public"."enum_orders_payment_method" AS ENUM('invoice', 'free', 'credit');
  CREATE TABLE "orders_add_ons" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"add_on_id" integer,
  	"name" varchar NOT NULL,
  	"key" varchar,
  	"placement" varchar,
  	"duration_days" numeric NOT NULL,
  	"unit_price" numeric NOT NULL,
  	"amount" numeric NOT NULL,
  	"included" boolean DEFAULT false
  );
  
  CREATE TABLE "orders_tax_lines" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"name" varchar NOT NULL,
  	"rate" numeric NOT NULL,
  	"xero_tax_type" varchar,
  	"net" numeric NOT NULL,
  	"tax" numeric NOT NULL,
  	"gross" numeric NOT NULL
  );
  
  CREATE TABLE "orders_external_refs" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"provider" varchar NOT NULL,
  	"external_id" varchar NOT NULL,
  	"url" varchar
  );
  
  CREATE TABLE "orders_log" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"at" timestamp(3) with time zone NOT NULL,
  	"event" "enum_orders_log_event" NOT NULL,
  	"actor" "enum_orders_log_actor" NOT NULL,
  	"by_id" integer,
  	"from" varchar,
  	"to" varchar,
  	"note" varchar
  );
  
  CREATE TABLE "orders" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"status" "enum_orders_status" DEFAULT 'pending' NOT NULL,
  	"organisation_id" integer NOT NULL,
  	"plan_id" integer,
  	"coupon_id" integer,
  	"coupon_code" varchar,
  	"currency" varchar NOT NULL,
  	"subtotal" numeric NOT NULL,
  	"discount" numeric NOT NULL,
  	"tax" numeric NOT NULL,
  	"total" numeric NOT NULL,
  	"tax_inclusive" boolean DEFAULT false,
  	"quote" jsonb,
  	"payment_method" "enum_orders_payment_method" DEFAULT 'invoice' NOT NULL,
  	"payment_provider" varchar,
  	"paid_at" timestamp(3) with time zone,
  	"legacy_id" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "orders_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"jobs_id" integer,
  	"users_id" integer
  );
  
  ALTER TABLE "jobs" ADD COLUMN "order_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "orders_id" integer;
  ALTER TABLE "orders_add_ons" ADD CONSTRAINT "orders_add_ons_add_on_id_add_ons_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_ons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders_add_ons" ADD CONSTRAINT "orders_add_ons_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_tax_lines" ADD CONSTRAINT "orders_tax_lines_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_external_refs" ADD CONSTRAINT "orders_external_refs_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_log" ADD CONSTRAINT "orders_log_by_id_users_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders_log" ADD CONSTRAINT "orders_log_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders_rels" ADD CONSTRAINT "orders_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_rels" ADD CONSTRAINT "orders_rels_jobs_fk" FOREIGN KEY ("jobs_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_rels" ADD CONSTRAINT "orders_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "orders_add_ons_order_idx" ON "orders_add_ons" USING btree ("_order");
  CREATE INDEX "orders_add_ons_parent_id_idx" ON "orders_add_ons" USING btree ("_parent_id");
  CREATE INDEX "orders_add_ons_add_on_idx" ON "orders_add_ons" USING btree ("add_on_id");
  CREATE INDEX "orders_tax_lines_order_idx" ON "orders_tax_lines" USING btree ("_order");
  CREATE INDEX "orders_tax_lines_parent_id_idx" ON "orders_tax_lines" USING btree ("_parent_id");
  CREATE INDEX "orders_external_refs_order_idx" ON "orders_external_refs" USING btree ("_order");
  CREATE INDEX "orders_external_refs_parent_id_idx" ON "orders_external_refs" USING btree ("_parent_id");
  CREATE INDEX "orders_log_order_idx" ON "orders_log" USING btree ("_order");
  CREATE INDEX "orders_log_parent_id_idx" ON "orders_log" USING btree ("_parent_id");
  CREATE INDEX "orders_log_by_idx" ON "orders_log" USING btree ("by_id");
  CREATE INDEX "orders_tenant_idx" ON "orders" USING btree ("tenant_id");
  CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");
  CREATE INDEX "orders_organisation_idx" ON "orders" USING btree ("organisation_id");
  CREATE INDEX "orders_plan_idx" ON "orders" USING btree ("plan_id");
  CREATE INDEX "orders_coupon_idx" ON "orders" USING btree ("coupon_id");
  CREATE INDEX "orders_payment_provider_idx" ON "orders" USING btree ("payment_provider");
  CREATE INDEX "orders_paid_at_idx" ON "orders" USING btree ("paid_at");
  CREATE INDEX "orders_legacy_id_idx" ON "orders" USING btree ("legacy_id");
  CREATE INDEX "orders_updated_at_idx" ON "orders" USING btree ("updated_at");
  CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");
  CREATE INDEX "orders_rels_order_idx" ON "orders_rels" USING btree ("order");
  CREATE INDEX "orders_rels_parent_idx" ON "orders_rels" USING btree ("parent_id");
  CREATE INDEX "orders_rels_path_idx" ON "orders_rels" USING btree ("path");
  CREATE INDEX "orders_rels_jobs_id_idx" ON "orders_rels" USING btree ("jobs_id");
  CREATE INDEX "orders_rels_users_id_idx" ON "orders_rels" USING btree ("users_id");
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_orders_fk" FOREIGN KEY ("orders_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "jobs_order_idx" ON "jobs" USING btree ("order_id");
  CREATE INDEX "payload_locked_documents_rels_orders_id_idx" ON "payload_locked_documents_rels" USING btree ("orders_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "orders_add_ons" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "orders_tax_lines" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "orders_external_refs" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "orders_log" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "orders" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "orders_rels" DISABLE ROW LEVEL SECURITY;
  -- mission-control: drop the foreign keys into "orders" first; DROP TABLE ... CASCADE removes
  -- them, and the generated order then failed on the explicit DROP CONSTRAINT.
  ALTER TABLE "jobs" DROP CONSTRAINT "jobs_order_id_orders_id_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_orders_fk";
  DROP TABLE "orders_add_ons" CASCADE;
  DROP TABLE "orders_tax_lines" CASCADE;
  DROP TABLE "orders_external_refs" CASCADE;
  DROP TABLE "orders_log" CASCADE;
  DROP TABLE "orders" CASCADE;
  DROP TABLE "orders_rels" CASCADE;
  DROP INDEX "jobs_order_idx";
  DROP INDEX "payload_locked_documents_rels_orders_id_idx";
  ALTER TABLE "jobs" DROP COLUMN "order_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "orders_id";
  DROP TYPE "public"."enum_orders_log_event";
  DROP TYPE "public"."enum_orders_log_actor";
  DROP TYPE "public"."enum_orders_status";
  DROP TYPE "public"."enum_orders_payment_method";`)
}
