-- CreateTable
CREATE TABLE "oauth_token" (
    "id" BIGSERIAL NOT NULL,
    "portal_id" BIGINT NOT NULL,
    "refresh_token_ciphertext" BYTEA NOT NULL,
    "refresh_token_iv" BYTEA NOT NULL,
    "refresh_token_auth_tag" BYTEA NOT NULL,
    "scopes" TEXT[],
    "access_token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_token_portal_id_key" ON "oauth_token"("portal_id");
