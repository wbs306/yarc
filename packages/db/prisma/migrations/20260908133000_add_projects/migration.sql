CREATE TABLE "projects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "directory_name" TEXT NOT NULL,
  "description" TEXT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "projects_directory_name_key" ON "projects"("directory_name");
CREATE INDEX "projects_updated_at_idx" ON "projects"("updated_at" DESC);

ALTER TABLE "conversations" ADD COLUMN "project_id" UUID;
CREATE INDEX "conversations_project_id_idx" ON "conversations"("project_id");
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_history_checkpoints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_history_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_history_checkpoints_project_id_created_at_idx"
  ON "project_history_checkpoints"("project_id", "created_at" DESC);
ALTER TABLE "project_history_checkpoints" ADD CONSTRAINT "project_history_checkpoints_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_history_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "checkpoint_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "path" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "blob_hash" TEXT,
  "size" INTEGER NOT NULL,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_history_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_history_revisions_project_id_path_created_at_idx"
  ON "project_history_revisions"("project_id", "path", "created_at" DESC);
ALTER TABLE "project_history_revisions" ADD CONSTRAINT "project_history_revisions_checkpoint_id_fkey"
  FOREIGN KEY ("checkpoint_id") REFERENCES "project_history_checkpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
