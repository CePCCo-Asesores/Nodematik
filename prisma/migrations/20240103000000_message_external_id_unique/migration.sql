-- PostgreSQL allows multiple NULLs in a UNIQUE index (NULL != NULL),
-- so this correctly deduplicates non-null WA message IDs while allowing
-- messages with no external_id (outbound messages).
CREATE UNIQUE INDEX "messages_external_id_key" ON "messages"("external_id")
  WHERE "external_id" IS NOT NULL;
