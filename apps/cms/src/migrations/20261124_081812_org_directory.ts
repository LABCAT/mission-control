import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "pages_blocks_organisation_directory" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"intro" varchar,
  	"show_type_filter" boolean DEFAULT true,
  	"show_size_filter" boolean DEFAULT true,
  	"empty_label" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_organisation_directory" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"intro" varchar,
  	"show_type_filter" boolean DEFAULT true,
  	"show_size_filter" boolean DEFAULT true,
  	"empty_label" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  ALTER TABLE "tenants" ADD COLUMN "organisation_pages_need_approval" boolean DEFAULT true;
  ALTER TABLE "organisations" ADD COLUMN "possible_duplicate" boolean DEFAULT false;
  ALTER TABLE "pages_blocks_organisation_directory" ADD CONSTRAINT "pages_blocks_organisation_directory_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_organisation_directory" ADD CONSTRAINT "_pages_v_blocks_organisation_directory_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "pages_blocks_organisation_directory_order_idx" ON "pages_blocks_organisation_directory" USING btree ("_order");
  CREATE INDEX "pages_blocks_organisation_directory_parent_id_idx" ON "pages_blocks_organisation_directory" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_organisation_directory_path_idx" ON "pages_blocks_organisation_directory" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_organisation_directory_order_idx" ON "_pages_v_blocks_organisation_directory" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_organisation_directory_parent_id_idx" ON "_pages_v_blocks_organisation_directory" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_organisation_directory_path_idx" ON "_pages_v_blocks_organisation_directory" USING btree ("_path");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "pages_blocks_organisation_directory" CASCADE;
  DROP TABLE "_pages_v_blocks_organisation_directory" CASCADE;
  ALTER TABLE "tenants" DROP COLUMN "organisation_pages_need_approval";
  ALTER TABLE "organisations" DROP COLUMN "possible_duplicate";`)
}
