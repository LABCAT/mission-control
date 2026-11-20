import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "tenants_location_levels" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar
  );
  
  ALTER TABLE "jobs" DROP CONSTRAINT "jobs_location_id_locations_id_fk";
  
  DROP INDEX "jobs_location_idx";
  ALTER TABLE "tenants" ADD COLUMN "location_max_depth" numeric;
  ALTER TABLE "locations" ADD COLUMN "depth" numeric;
  ALTER TABLE "jobs_locales" ADD COLUMN "location_details" varchar;
  ALTER TABLE "jobs_rels" ADD COLUMN "locations_id" integer;
  ALTER TABLE "tenants_location_levels" ADD CONSTRAINT "tenants_location_levels_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "tenants_location_levels_order_idx" ON "tenants_location_levels" USING btree ("_order");
  CREATE INDEX "tenants_location_levels_parent_id_idx" ON "tenants_location_levels" USING btree ("_parent_id");
  ALTER TABLE "jobs_rels" ADD CONSTRAINT "jobs_rels_locations_fk" FOREIGN KEY ("locations_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "locations_depth_idx" ON "locations" USING btree ("depth");
  CREATE INDEX "jobs_rels_locations_id_idx" ON "jobs_rels" USING btree ("locations_id");
`)

  // mission-control: keep the data. `kind` becomes the computed `depth` (a root is 0, its
  // children 1, and so on), a job's single `location` becomes the first entry of its many
  // locations, and the old free-text `address` becomes `locationDetails`.
  await db.execute(sql`
  WITH RECURSIVE tree AS (
    SELECT "id", 0 AS depth FROM "locations" WHERE "parent_id" IS NULL
    UNION ALL
    SELECT l."id", tree.depth + 1 FROM "locations" l JOIN tree ON l."parent_id" = tree."id"
  )
  UPDATE "locations" SET "depth" = tree.depth FROM tree WHERE "locations"."id" = tree."id";
  UPDATE "locations" SET "depth" = 0 WHERE "depth" IS NULL;
  INSERT INTO "jobs_rels" ("order", "parent_id", "path", "locations_id")
    SELECT 1, "id", 'location', "location_id" FROM "jobs" WHERE "location_id" IS NOT NULL;
  UPDATE "jobs_locales" SET "location_details" = "jobs"."address"
    FROM "jobs" WHERE "jobs_locales"."_parent_id" = "jobs"."id" AND "jobs"."address" IS NOT NULL AND "jobs"."address" <> '';`)

  await db.execute(sql`
  ALTER TABLE "locations" DROP COLUMN "kind";
  ALTER TABLE "jobs" DROP COLUMN "location_id";
  ALTER TABLE "jobs" DROP COLUMN "address";
  DROP TYPE "public"."enum_locations_kind";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // The old `kind` (region, island, town) is not stored any more, so it cannot be restored
  // faithfully, and guessing would silently reclassify places. Rolling back is only allowed on
  // an empty tree; export or delete the locations first.
  const places = await db.execute(sql`SELECT count(*)::int AS count FROM "locations";`)

  if (places.rows[0]?.count) {
    throw new Error(
      `Refusing to roll back: ${places.rows[0].count} location(s) exist and their original kinds ` +
        'cannot be recovered. Delete them (or restore from a backup), then run migrate:down again.',
    )
  }

  // mission-control: the old schema holds one location per job. Rolling back a job that has
  // several would silently drop all but one, which is a data decision, so refuse instead.
  const many = await db.execute(
    sql`SELECT count(*)::int AS count FROM (SELECT "parent_id" FROM "jobs_rels" WHERE "path" = 'location' GROUP BY "parent_id" HAVING count(*) > 1) t;`,
  )

  if (many.rows[0]?.count) {
    throw new Error(
      `Refusing to roll back: ${many.rows[0].count} job(s) have more than one location. ` +
        'Reduce them to one location, then run migrate:down again.',
    )
  }

  await db.execute(sql`
   CREATE TYPE "public"."enum_locations_kind" AS ENUM('region', 'island', 'town');
  ALTER TABLE "tenants_location_levels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "tenants_location_levels" CASCADE;
  ALTER TABLE "jobs_rels" DROP CONSTRAINT "jobs_rels_locations_fk";
  
  DROP INDEX "locations_depth_idx";
  DROP INDEX "jobs_rels_locations_id_idx";
  ALTER TABLE "locations" ADD COLUMN "kind" "enum_locations_kind";
  ALTER TABLE "jobs" ADD COLUMN "location_id" integer;
  ALTER TABLE "jobs" ADD COLUMN "address" varchar;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "jobs_location_idx" ON "jobs" USING btree ("location_id");
  ALTER TABLE "tenants" DROP COLUMN "location_max_depth";`)

  // The tree is empty here (guarded above), so `kind` can be required again.
  await db.execute(sql`
  ALTER TABLE "locations" ALTER COLUMN "kind" SET NOT NULL;
  UPDATE "jobs" SET "location_id" = r."locations_id"
    FROM "jobs_rels" r WHERE r."parent_id" = "jobs"."id" AND r."path" = 'location';
  UPDATE "jobs" SET "address" = l."location_details"
    FROM (SELECT DISTINCT ON ("_parent_id") "_parent_id", "location_details" FROM "jobs_locales"
          WHERE "location_details" IS NOT NULL ORDER BY "_parent_id", "_locale") l
    WHERE l."_parent_id" = "jobs"."id";
  ALTER TABLE "locations" DROP COLUMN "depth";
  ALTER TABLE "jobs_locales" DROP COLUMN "location_details";
  DELETE FROM "jobs_rels" WHERE "path" = 'location';
  ALTER TABLE "jobs_rels" DROP COLUMN "locations_id";`)
}
