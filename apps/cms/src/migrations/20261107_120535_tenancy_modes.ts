import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "tenants_locales" RENAME TO "tenant_locale_list";
  ALTER TABLE "tenant_locale_list" ALTER COLUMN "locale" DROP NOT NULL;
  ALTER TABLE "tenant_locale_list" RENAME CONSTRAINT "tenants_locales_parent_id_fk" TO "tenant_locale_list_parent_id_fk";
  ALTER INDEX "tenants_locales_order_idx" RENAME TO "tenant_locale_list_order_idx";
  ALTER INDEX "tenants_locales_parent_id_idx" RENAME TO "tenant_locale_list_parent_id_idx";
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
  -- Aggregate tenants cannot satisfy the old NOT NULL schema. Fill neutral values rather
  -- than deleting the rows, so a rollback never loses tenant identity.
  UPDATE "tenants" SET
    "currency" = COALESCE("currency", 'XXX'),
    "currency_minor_units" = COALESCE("currency_minor_units", 0),
    "timezone" = COALESCE("timezone", 'UTC'),
    "default_locale" = COALESCE("default_locale", 'en'),
    "tax_label" = COALESCE("tax_label", 'Tax'),
    "email_from_name" = COALESCE("email_from_name", 'Rollback'),
    "email_from_address" = COALESCE("email_from_address", 'noreply@example.invalid'),
    "admin_email" = COALESCE("admin_email", 'admin@example.invalid'),
    "branding_color_primary" = COALESCE("branding_color_primary", '#000000'),
    "branding_color_accent" = COALESCE("branding_color_accent", '#000000'),
    "branding_color_hover" = COALESCE("branding_color_hover", '#000000');
  UPDATE "tenant_locale_list" SET "locale" = 'en' WHERE "locale" IS NULL;
  ALTER TABLE "tenants" ALTER COLUMN "currency" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "currency_minor_units" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "timezone" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "default_locale" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "tax_label" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "email_from_name" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "email_from_address" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "admin_email" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_primary" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_accent" SET NOT NULL;
  ALTER TABLE "tenants" ALTER COLUMN "branding_color_hover" SET NOT NULL;
  ALTER TABLE "tenant_locale_list" ALTER COLUMN "locale" SET NOT NULL;
  ALTER TABLE "tenant_locale_list" RENAME CONSTRAINT "tenant_locale_list_parent_id_fk" TO "tenants_locales_parent_id_fk";
  ALTER INDEX "tenant_locale_list_order_idx" RENAME TO "tenants_locales_order_idx";
  ALTER INDEX "tenant_locale_list_parent_id_idx" RENAME TO "tenants_locales_parent_id_idx";
  ALTER TABLE "tenant_locale_list" RENAME TO "tenants_locales";`)
}
