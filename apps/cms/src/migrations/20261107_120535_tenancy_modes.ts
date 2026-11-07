import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE "tenant_locale_list" (
	"_order" integer NOT NULL,
	"_parent_id" integer NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"locale" varchar
);

  ALTER TABLE "tenants_locales" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "tenants_locales" CASCADE;
  ALTER TABLE "tenants" ALTER COLUMN "currency" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "currency_minor_units" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "timezone" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "default_locale" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "tax_label" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "email_from_name" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "email_from_address" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "admin_email" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_primary" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_accent" DROP NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_hover" DROP NOT NULL;
  ALTER TABLE "tenant_locale_list" ADD CONSTRAINT "tenant_locale_list_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "tenant_locale_list_order_idx" ON "tenant_locale_list" USING btree ("_order");
  CREATE INDEX "tenant_locale_list_parent_id_idx" ON "tenant_locale_list" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE "tenants_locales" (
	"_order" integer NOT NULL,
	"_parent_id" integer NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"locale" varchar NOT NULL
);

  ALTER TABLE "tenant_locale_list" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "tenant_locale_list" CASCADE;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_primary" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_accent" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_hover" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "currency" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "currency_minor_units" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "timezone" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "default_locale" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "tax_label" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "email_from_name" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "email_from_address" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "admin_email" SET NOT NULL;
  ALTER TABLE "tenants_locales" ADD CONSTRAINT "tenants_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "tenants_locales_order_idx" ON "tenants_locales" USING btree ("_order");
  CREATE INDEX "tenants_locales_parent_id_idx" ON "tenants_locales" USING btree ("_parent_id");`)
}
