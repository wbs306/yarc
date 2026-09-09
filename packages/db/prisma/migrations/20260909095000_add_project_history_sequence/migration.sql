-- Add an explicit monotonic ordering key for Writing History checkpoints.
-- Timestamps remain presentation metadata; restore semantics use sequence.
ALTER TABLE "project_history_checkpoints"
ADD COLUMN "sequence" SERIAL NOT NULL;

CREATE UNIQUE INDEX "project_history_checkpoints_project_id_sequence_key"
ON "project_history_checkpoints"("project_id", "sequence");

CREATE INDEX "project_history_checkpoints_project_id_sequence_idx"
ON "project_history_checkpoints"("project_id", "sequence" DESC);
