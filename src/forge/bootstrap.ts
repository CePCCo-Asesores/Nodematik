/**
 * Bootstrap del operador FORGE: registra los adaptadores de extracción
 * y conecta la tubería del motor del lazo con el orquestador real.
 *
 * Debe llamarse UNA VEZ al arrancar el worker, antes de procesar cualquier
 * solicitud o ráfaga. Es idempotente — llamarlo varias veces no produce
 * efectos secundarios, pero no tiene sentido hacerlo.
 */

import { db } from '../db'
import { registrarAdaptador, orquestar } from './extract/orquestador'
import { configurarTuberia } from './loop/motor'
import { AdaptadorFeed } from './extract/adaptadores/feed'
import { AdaptadorApi } from './extract/adaptadores/api'
import { AdaptadorWeb } from './extract/adaptadores/web'
import { AdaptadorArchivo } from './extract/adaptadores/archivo'
import { AdaptadorDataset } from './extract/adaptadores/dataset'
import type { PlanExtraccion } from './extract/types'

export function bootstrapForge(): void {
  // ── 1. Adaptadores de extracción ───────────────────────────────────────────
  // El orquestador despacha por metodo_acceso. Sin este registro lanza error
  // para cualquier fuente que no sea de un tipo conocido.
  registrarAdaptador('feed', AdaptadorFeed)
  registrarAdaptador('api', AdaptadorApi)
  registrarAdaptador('web', AdaptadorWeb)
  registrarAdaptador('archivo_cliente', AdaptadorArchivo)
  registrarAdaptador('dataset_abierto', AdaptadorDataset)

  // ── 2. Tubería del motor del lazo ──────────────────────────────────────────
  // El motor llama esta función en cada ráfaga. Carga el plan de la solicitud
  // original (fichaId == solicitudId) y corre extracción con los adaptadores
  // ya registrados arriba.
  configurarTuberia(async (loopId, fichaId, _orgId) => {
    const solicitud = await db.solicitud.findUnique({
      where: { id: fichaId },
      select: { planJson: true },
    })

    if (!solicitud?.planJson) {
      throw new Error(
        `Loop '${loopId}': solicitud '${fichaId}' no encontrada o sin plan de fuentes. ` +
        'El pipeline debe completar el paso forge-sources antes de activar el lazo.',
      )
    }

    const plan = solicitud.planJson as unknown as PlanExtraccion
    const resultado = await orquestar(plan, {})
    // ResultadoExtraccion → Record para que el motor pueda acceder a registros
    // y cobertura_pct sin conocer el tipo concreto del extractor.
    return resultado as unknown as Record<string, unknown>
  })
}
