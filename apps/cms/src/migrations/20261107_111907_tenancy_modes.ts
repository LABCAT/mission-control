import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants_locales" ALTER COLUMN "locale" DROP NOT NULL;
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
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_hover" DROP NOT NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants_locales" ALTER COLUMN "locale" SET NOT NULL;
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
  ALTER TABLE "tenants" ALTER COLUMN "admin_email" SET NOT NULL;`)
}
