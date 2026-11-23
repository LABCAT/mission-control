import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "audit_log" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"action" varchar NOT NULL,
  	"actor_i_d" varchar NOT NULL,
  	"target_i_d" varchar,
  	"tenant_i_d" varchar,
  	"session_i_d" varchar,
  	"detail" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "audit_log_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "audit_log_id" integer;
  ALTER TABLE "audit_log_rels" ADD CONSTRAINT "audit_log_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."audit_log"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "audit_log_rels" ADD CONSTRAINT "audit_log_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");
  CREATE INDEX "audit_log_actor_i_d_idx" ON "audit_log" USING btree ("actor_i_d");
  CREATE INDEX "audit_log_target_i_d_idx" ON "audit_log" USING btree ("target_i_d");
  CREATE INDEX "audit_log_tenant_i_d_idx" ON "audit_log" USING btree ("tenant_i_d");
  CREATE INDEX "audit_log_session_i_d_idx" ON "audit_log" USING btree ("session_i_d");
  CREATE INDEX "audit_log_updated_at_idx" ON "audit_log" USING btree ("updated_at");
  CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");
  CREATE INDEX "audit_log_rels_order_idx" ON "audit_log_rels" USING btree ("order");
  CREATE INDEX "audit_log_rels_parent_idx" ON "audit_log_rels" USING btree ("parent_id");
  CREATE INDEX "audit_log_rels_path_idx" ON "audit_log_rels" USING btree ("path");
  CREATE INDEX "audit_log_rels_users_id_idx" ON "audit_log_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_audit_log_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_log"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_audit_log_id_idx" ON "payload_locked_documents_rels" USING btree ("audit_log_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "audit_log" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "audit_log_rels" DISABLE ROW LEVEL SECURITY;
  -- mission-control: drop the foreign key into "audit_log" first; DROP TABLE ... CASCADE
  -- removes it, and the generated order then failed on the explicit DROP CONSTRAINT.
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_audit_log_fk";
  DROP TABLE "audit_log" CASCADE;
  DROP TABLE "audit_log_rels" CASCADE;
  
  DROP INDEX "payload_locked_documents_rels_audit_log_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "audit_log_id";`)
}
