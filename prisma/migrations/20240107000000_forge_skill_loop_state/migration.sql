-- Skills generados por cliente vía FACTORY.
-- Los skills base (forge-intake, forge-sources, etc.) viven en el repo (src/forge/skills/)
-- y NO en esta tabla. Esta tabla almacena solo contenido generado que pertenece a una org.

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "validators" JSONB,
    "verbo_central" TEXT NOT NULL,
    "nivel_generalizacion" TEXT NOT NULL DEFAULT 'cliente',
    "forge_approved" BOOLEAN NOT NULL DEFAULT false,
    "requiere_revision_humana" BOOLEAN NOT NULL DEFAULT false,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- Estado persistente del lazo continuo forge-loop.
-- Un lazo es un estado en reposo que el scheduler despierta en ráfagas.
-- IMPORTANTE: todo acceso de ejecución debe usar SELECT … FOR UPDATE SKIP LOCKED
-- por loop_id para evitar ráfagas concurrentes sobre el mismo lazo.

-- CreateTable
CREATE TABLE "loop_states" (
    "loop_id" TEXT NOT NULL,
    "ficha_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "ritmo" JSONB NOT NULL,
    "estado_operativo" TEXT NOT NULL DEFAULT 'activo',
    "ultima_ejecucion" TIMESTAMP(3),
    "proxima_ejecucion" TIMESTAMP(3),
    "ejecuciones_totales" INTEGER NOT NULL DEFAULT 0,
    "huella_anterior" JSONB,
    "skill_operante" JSONB NOT NULL,
    "fallos_consecutivos" INTEGER NOT NULL DEFAULT 0,
    "ultima_anomalia" JSONB,
    "pendiente_aprobacion" BOOLEAN NOT NULL DEFAULT false,
    "politica_adaptacion" JSONB NOT NULL,
    "cooldown_adaptacion_hasta" TIMESTAMP(3),
    "adaptaciones_en_periodo" JSONB NOT NULL DEFAULT '{}',
    "historial" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loop_states_pkey" PRIMARY KEY ("loop_id")
);

-- CreateIndex: unicidad por (org, nombre, versión) — un cliente no puede tener dos versiones iguales activas
CREATE UNIQUE INDEX "skills_org_id_name_version_key" ON "skills"("org_id", "name", "version");

-- CreateIndex: búsqueda por org (listado de skills del cliente)
CREATE INDEX "skills_org_id_idx" ON "skills"("org_id");

-- CreateIndex: clave del scheduler — lista lazos activos cuya próxima ejecución ya pasó
CREATE INDEX "loop_states_estado_operativo_proxima_ejecucion_idx" ON "loop_states"("estado_operativo", "proxima_ejecucion");

-- CreateIndex: búsqueda por org (listado de lazos del cliente)
CREATE INDEX "loop_states_org_id_idx" ON "loop_states"("org_id");

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_states" ADD CONSTRAINT "loop_states_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
