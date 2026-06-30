-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "papers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "year" INTEGER,
    "doi" TEXT,
    "arxiv_id" TEXT,
    "url" TEXT,
    "file_path" TEXT,
    "file_size" INTEGER,
    "category_id" UUID,
    "parse_status" TEXT NOT NULL DEFAULT 'pending',
    "parse_result" JSONB,
    "parsed_at" TIMESTAMP(3),
    "embedding_status" TEXT NOT NULL DEFAULT 'pending',
    "embedding_progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "embedded_at" TIMESTAMP(3),
    "summary_status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT,
    "summarized_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paper_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "page_number" INTEGER,
    "highlight_text" TEXT,
    "highlight_rect" JSONB,
    "kind" TEXT NOT NULL DEFAULT 'note',
    "file_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paper_id" UUID,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "model" TEXT,
    "system_prompt" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paper_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "page_number" INTEGER,
    "chunk_index" INTEGER,
    "embedding" vector(1536),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paper_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stream_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "papers_category_id_idx" ON "papers"("category_id");

-- CreateIndex
CREATE INDEX "papers_created_at_idx" ON "papers"("created_at" DESC);

-- CreateIndex
CREATE INDEX "notes_paper_id_idx" ON "notes"("paper_id");

-- CreateIndex
CREATE INDEX "notes_paper_id_page_number_idx" ON "notes"("paper_id", "page_number");

-- CreateIndex
CREATE INDEX "paper_chunks_paper_id_idx" ON "paper_chunks"("paper_id");

-- CreateIndex
CREATE INDEX "idx_chunks_embedding_hnsw" ON "paper_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- CreateIndex
CREATE INDEX "tasks_status_created_at_idx" ON "tasks"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_stream_events_conversation" ON "stream_events"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "stream_events_message_id_seq_key" ON "stream_events"("message_id", "seq");

-- AddForeignKey
ALTER TABLE "papers" ADD CONSTRAINT "papers_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_chunks" ADD CONSTRAINT "paper_chunks_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_paper_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_events" ADD CONSTRAINT "stream_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
