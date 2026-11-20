import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tenants_tax_rounding" AS ENUM('invoice', 'line');
  CREATE TABLE "tenants_tax_rates" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"name" varchar,
  	"rate" numeric,
  	"xero_tax_type" varchar
  );
  
  ALTER TABLE "tenants" ADD COLUMN "tax_enabled" boolean DEFAULT false;
  ALTER TABLE "tenants" ADD COLUMN "tax_prices_include_tax" boolean DEFAULT false;
  ALTER TABLE "tenants" ADD COLUMN "tax_rounding" "enum_tenants_tax_rounding" DEFAULT 'invoice';
  ALTER TABLE "tenants" ADD COLUMN "tax_default_rate_key" varchar;
  ALTER TABLE "tenants" ADD COLUMN "tax_exempt_xero_tax_type" varchar;
  ALTER TABLE "plans" ADD COLUMN "tax_exempt" boolean DEFAULT false;
  ALTER TABLE "plans" ADD COLUMN "tax_rate_key" varchar;
  ALTER TABLE "add_ons" ADD COLUMN "tax_exempt" boolean DEFAULT false;
  ALTER TABLE "add_ons" ADD COLUMN "tax_rate_key" varchar;
  ALTER TABLE "tenants_tax_rates" ADD CONSTRAINT "tenants_tax_rates_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "tenants_tax_rates_order_idx" ON "tenants_tax_rates" USING btree ("_order");
  CREATE INDEX "tenants_tax_rates_parent_id_idx" ON "tenants_tax_rates" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "tenants_tax_rates" CASCADE;
  ALTER TABLE "tenants" DROP COLUMN "tax_enabled";
  ALTER TABLE "tenants" DROP COLUMN "tax_prices_include_tax";
  ALTER TABLE "tenants" DROP COLUMN "tax_rounding";
  ALTER TABLE "tenants" DROP COLUMN "tax_default_rate_key";
  ALTER TABLE "tenants" DROP COLUMN "tax_exempt_xero_tax_type";
  ALTER TABLE "plans" DROP COLUMN "tax_exempt";
  ALTER TABLE "plans" DROP COLUMN "tax_rate_key";
  ALTER TABLE "add_ons" DROP COLUMN "tax_exempt";
  ALTER TABLE "add_ons" DROP COLUMN "tax_rate_key";
  DROP TYPE "public"."enum_tenants_tax_rounding";`)
}
