-- CreateTable
CREATE TABLE "heartbeat" (
    "id" BIGSERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "heartbeat_source_created_at_idx" ON "heartbeat"("source", "created_at");
