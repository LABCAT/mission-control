import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_email_log_bounce_type" AS ENUM('hard', 'soft');
  CREATE TYPE "public"."enum_email_suppressions_reason" AS ENUM('bounce', 'complaint');
  ALTER TYPE "public"."enum_email_log_status" ADD VALUE 'deferred';
  ALTER TYPE "public"."enum_email_log_status" ADD VALUE 'delivered';
  ALTER TYPE "public"."enum_email_log_status" ADD VALUE 'bounced';
  ALTER TYPE "public"."enum_email_log_status" ADD VALUE 'rejected';
  ALTER TYPE "public"."enum_email_log_status" ADD VALUE 'complained';
  CREATE TABLE "email_suppressions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tenant_id" integer,
  	"address" varchar NOT NULL,
  	"reason" "enum_email_suppressions_reason" NOT NULL,
  	"suppressed_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "email_suppressions_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "email_log" ADD COLUMN "message_id" varchar;
  ALTER TABLE "email_log" ADD COLUMN "bounce_type" "enum_email_log_bounce_type";
  ALTER TABLE "email_log" ADD COLUMN "status_at" timestamp(3) with time zone;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "email_suppressions_id" integer;
  ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "email_suppressions_rels" ADD CONSTRAINT "email_suppressions_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."email_suppressions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "email_suppressions_rels" ADD CONSTRAINT "email_suppressions_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "email_suppressions_tenant_idx" ON "email_suppressions" USING btree ("tenant_id");
  CREATE INDEX "email_suppressions_address_idx" ON "email_suppressions" USING btree ("address");
  CREATE INDEX "email_suppressions_updated_at_idx" ON "email_suppressions" USING btree ("updated_at");
  CREATE INDEX "email_suppressions_created_at_idx" ON "email_suppressions" USING btree ("created_at");
  CREATE UNIQUE INDEX "tenant_address_idx" ON "email_suppressions" USING btree ("tenant_id","address");
  CREATE INDEX "email_suppressions_rels_order_idx" ON "email_suppressions_rels" USING btree ("order");
  CREATE INDEX "email_suppressions_rels_parent_idx" ON "email_suppressions_rels" USING btree ("parent_id");
  CREATE INDEX "email_suppressions_rels_path_idx" ON "email_suppressions_rels" USING btree ("path");
  CREATE INDEX "email_suppressions_rels_users_id_idx" ON "email_suppressions_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_email_suppressions_fk" FOREIGN KEY ("email_suppressions_id") REFERENCES "public"."email_suppressions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "email_log_message_id_idx" ON "email_log" USING btree ("message_id");
  CREATE INDEX "payload_locked_documents_rels_email_suppressions_id_idx" ON "payload_locked_documents_rels" USING btree ("email_suppressions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Rolling back would cast the status enum back and drop the suppression list. Delivery history
  // and suppressions are never deleted, so refuse (with a clear message) once either holds data.
  const used = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM "email_log" WHERE "status" IN ('deferred', 'delivered', 'bounced', 'rejected', 'complained'))::int AS statuses,
      (SELECT count(*) FROM "email_suppressions")::int AS suppressions`)
  const counts = (used.rows[0] ?? {}) as { statuses?: number; suppressions?: number }
  if ((counts.statuses ?? 0) > 0 || (counts.suppressions ?? 0) > 0) {
    throw new Error(
      `Cannot roll back email_deliverability: ${counts.statuses ?? 0} email-log rows use a delivery status and ` +
        `${counts.suppressions ?? 0} addresses are suppressed. Nothing was changed; this data is never deleted.`,
    )
  }

  await db.execute(sql`
   ALTER TABLE "email_suppressions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "email_suppressions_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "email_suppressions" CASCADE;
  DROP TABLE "email_suppressions_rels" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_email_suppressions_fk";
  
  ALTER TABLE "email_log" ALTER COLUMN "status" SET DATA TYPE text;
  DROP TYPE "public"."enum_email_log_status";
  CREATE TYPE "public"."enum_email_log_status" AS ENUM('sent', 'failed', 'skipped');
  ALTER TABLE "email_log" ALTER COLUMN "status" SET DATA TYPE "public"."enum_email_log_status" USING "status"::"public"."enum_email_log_status";
  DROP INDEX "email_log_message_id_idx";
  DROP INDEX "payload_locked_documents_rels_email_suppressions_id_idx";
  ALTER TABLE "email_log" DROP COLUMN "message_id";
  ALTER TABLE "email_log" DROP COLUMN "bounce_type";
  ALTER TABLE "email_log" DROP COLUMN "status_at";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "email_suppressions_id";
  DROP TYPE "public"."enum_email_log_bounce_type";
  DROP TYPE "public"."enum_email_suppressions_reason";`)
}
