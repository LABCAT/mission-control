import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tags_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__tags_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__tags_v_published_locale" AS ENUM('en');
  ALTER TABLE "tags" ALTER COLUMN "name" DROP NOT NULL;
  ALTER TABLE "_tags_v" ALTER COLUMN "version_name" DROP NOT NULL;
  ALTER TABLE "tags" ADD COLUMN "_status" "enum_tags_status" DEFAULT 'draft';
  ALTER TABLE "_tags_v" ADD COLUMN "version__status" "enum__tags_v_version_status" DEFAULT 'draft';
  ALTER TABLE "_tags_v" ADD COLUMN "published_locale" "enum__tags_v_published_locale";
  ALTER TABLE "_tags_v" ADD COLUMN "latest" boolean;
  CREATE INDEX "tags__status_idx" ON "tags" USING btree ("_status");
  CREATE INDEX "_tags_v_version_version__status_idx" ON "_tags_v" USING btree ("version__status");
  CREATE INDEX "_tags_v_published_locale_idx" ON "_tags_v" USING btree ("published_locale");
  CREATE INDEX "_tags_v_latest_idx" ON "_tags_v" USING btree ("latest");`)

  // mission-control: `_status` defaults to draft, so without this every tag that already exists
  // would leave public reads the moment drafts are enabled. Tags were all live before this
  // migration, so publish them.
  await db.execute(sql`UPDATE "tags" SET "_status" = 'published';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // mission-control: `_status` is the only way to express an unpublished tag, so rolling back
  // cannot preserve one — the row would either be published to the public API or deleted. Both
  // are data decisions, so refuse instead of guessing. Operators publish or remove the drafts
  // deliberately, then roll back.
  const drafts = await db.execute(
    sql`SELECT count(*)::int AS count FROM "tags" WHERE "_status" = 'draft';`,
  )

  if (drafts.rows[0]?.count) {
    throw new Error(
      `Refusing to roll back: ${drafts.rows[0].count} draft tag(s) would become public. ` +
        'Publish or delete them, then run migrate:down again.',
    )
  }

  await db.execute(sql`
   DROP INDEX "tags__status_idx";
  DROP INDEX "_tags_v_version_version__status_idx";
  DROP INDEX "_tags_v_published_locale_idx";
  DROP INDEX "_tags_v_latest_idx";
  ALTER TABLE "tags" ALTER COLUMN "name" SET NOT NULL;
  ALTER TABLE "_tags_v" ALTER COLUMN "version_name" SET NOT NULL;
  ALTER TABLE "tags" DROP COLUMN "_status";
  ALTER TABLE "_tags_v" DROP COLUMN "version__status";
  ALTER TABLE "_tags_v" DROP COLUMN "published_locale";
  ALTER TABLE "_tags_v" DROP COLUMN "latest";
  DROP TYPE "public"."enum_tags_status";
  DROP TYPE "public"."enum__tags_v_version_status";
  DROP TYPE "public"."enum__tags_v_published_locale";`)
}
