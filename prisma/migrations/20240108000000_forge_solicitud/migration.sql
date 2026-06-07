-- CreateTable: Solicitud (paso 8.5 — Operador Autónomo FORGE)
CREATE TABLE "solicitudes" (
    "id"              TEXT NOT NULL,
    "org_id"          TEXT NOT NULL,
    "bot_id"          TEXT NOT NULL,
    "problema"        TEXT NOT NULL,
    "estado"          TEXT NOT NULL DEFAULT 'pendiente',
    "ficha_json"      JSONB,
    "plan_json"       JSONB,
    "extraccion_json" JSONB,
    "encargo_json"    JSONB,
    "skill_id"        TEXT,
    "loop_id"         TEXT,
    "error_detalle"   TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solicitudes_pkey" PRIMARY KEY ("id")
);

-- Índice para listar solicitudes de una org ordenadas por fecha
CREATE INDEX "solicitudes_org_id_created_at_idx" ON "solicitudes"("org_id", "created_at");

-- Índice para filtrar por estado (polling de jobs pendientes)
CREATE INDEX "solicitudes_estado_idx" ON "solicitudes"("estado");

-- Foreign Keys
ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_bot_id_fkey"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
