/**
 * Implementación de AlmacenEstado sobre Postgres (Prisma) + Redis.
 *
 * Patrón de lock: Redis NX con TTL de 120 s (mismo patrón que el mutex de
 * conversación en queue/consumer.ts). Equivale semánticamente a
 * SELECT FOR UPDATE SKIP LOCKED — si el lock ya está tomado, cargarConLock
 * retorna null inmediatamente y el motor omite ese lazo.
 *
 * listarPendientes():
 *   WHERE estado_operativo='activo' AND proxima_ejecucion <= NOW()
 *   (usa el índice compuesto definido en el schema)
 */

import type { Redis } from 'ioredis'

import { db } from '../../db'
import type {
  AdaptacionesEnPeriodo,
  AlmacenEstado,
  EntradaHistorial,
  EstadoLazo,
  EstadoOperativo,
  Huella,
  PoliticaAdaptacion,
  Ritmo,
  SkillOperante,
} from './types'

const LOCK_PREFIX = 'forge:loop:lock:'
const LOCK_TTL_MS = 120_000   // 2 min — cubre peor caso de extracción lenta

// ─── Implementación pública ───────────────────────────────────────────────────

export class AlmacenEstadoPrisma implements AlmacenEstado {
  constructor(private readonly redis: Redis) {}

  async cargarConLock(loopId: string): Promise<EstadoLazo | null> {
    const lockKey = `${LOCK_PREFIX}${loopId}`
    const acquired = await this.redis.set(lockKey, '1', 'PX', LOCK_TTL_MS, 'NX')
    if (!acquired) return null  // otro worker lo tiene

    const row = await db.loopState.findUnique({ where: { loopId } })
    if (!row) {
      await this.redis.del(lockKey)
      return null
    }

    return mapRowToEstado(row)
  }

  async guardarYLiberar(estado: EstadoLazo): Promise<void> {
    const lockKey = `${LOCK_PREFIX}${estado.loopId}`

    // Calcular proxima_ejecucion si el motor la dejó en null (tipo cron)
    let proximaEjecucion = estado.proximaEjecucion
    if (!proximaEjecucion && estado.estadoOperativo === 'activo' && estado.ritmo.tipo === 'cron') {
      proximaEjecucion = calcularProximaCron(estado.ritmo.valor, estado.ultimaEjecucion ?? new Date())
    }

    await db.loopState.update({
      where: { loopId: estado.loopId },
      data: {
        estadoOperativo: estado.estadoOperativo,
        ultimaEjecucion: estado.ultimaEjecucion,
        proximaEjecucion,
        ejecucionesTotales: estado.ejecucionesTotales,
        huellaAnterior: estado.huellaAnterior as object ?? undefined,
        skillOperante: estado.skillOperante as object,
        fallosConsecutivos: estado.fallosConsecutivos,
        ultimaAnomalia: estado.ultimaAnomalia ?? undefined,
        pendienteAprobacion: estado.pendienteAprobacion,
        politicaAdaptacion: estado.politicaAdaptacion as object,
        cooldownAdaptacionHasta: estado.cooldownAdaptacionHasta,
        adaptacionesEnPeriodo: estado.adaptacionesEnPeriodo as object,
        historial: estado.historial as object[],
        ritmo: estado.ritmo as object,
      },
    })

    await this.redis.del(lockKey)
  }

  async listarPendientes(): Promise<string[]> {
    const rows = await db.loopState.findMany({
      where: {
        estadoOperativo: 'activo',
        proximaEjecucion: { lte: new Date() },
      },
      select: { loopId: true },
    })
    return rows.map(r => r.loopId)
  }
}

// ─── Mapper Prisma row → EstadoLazo ──────────────────────────────────────────

function mapRowToEstado(row: {
  loopId: string
  fichaId: string
  orgId: string
  ritmo: unknown
  estadoOperativo: string
  ultimaEjecucion: Date | null
  proximaEjecucion: Date | null
  ejecucionesTotales: number
  huellaAnterior: unknown
  skillOperante: unknown
  fallosConsecutivos: number
  ultimaAnomalia: unknown
  pendienteAprobacion: boolean
  politicaAdaptacion: unknown
  cooldownAdaptacionHasta: Date | null
  adaptacionesEnPeriodo: unknown
  historial: unknown
}): EstadoLazo {
  const ap = (row.adaptacionesEnPeriodo as Record<string, unknown> | null) ?? {}

  return {
    loopId: row.loopId,
    fichaId: row.fichaId,
    orgId: row.orgId,
    ritmo: row.ritmo as Ritmo,
    estadoOperativo: row.estadoOperativo as EstadoOperativo,
    ultimaEjecucion: row.ultimaEjecucion,
    proximaEjecucion: row.proximaEjecucion,
    ejecucionesTotales: row.ejecucionesTotales,
    huellaAnterior: (row.huellaAnterior as Huella | null) ?? null,
    skillOperante: row.skillOperante as SkillOperante,
    fallosConsecutivos: row.fallosConsecutivos,
    ultimaAnomalia: (row.ultimaAnomalia as { tipo: string; detalle: string; ts: string } | null) ?? null,
    pendienteAprobacion: row.pendienteAprobacion,
    politicaAdaptacion: normalizarPolitica(row.politicaAdaptacion),
    cooldownAdaptacionHasta: row.cooldownAdaptacionHasta,
    adaptacionesEnPeriodo: {
      periodoInicio: (ap['periodoInicio'] as string | undefined) ?? (ap['periodo_inicio'] as string | undefined) ?? '',
      count: (ap['count'] as number | undefined) ?? 0,
    } as AdaptacionesEnPeriodo,
    historial: ((row.historial as unknown[]) ?? []) as EntradaHistorial[],
  }
}

function normalizarPolitica(raw: unknown): PoliticaAdaptacion {
  if (!raw || typeof raw !== 'object') {
    return { adaptarSi: '', noAdaptarSi: '', maxAdaptacionesPorPeriodo: 3, periodoHoras: 24, extraccionVaciaEsFallo: true }
  }
  const p = raw as Record<string, unknown>
  return {
    adaptarSi: (p['adaptarSi'] ?? p['adaptar_si'] ?? '') as string,
    noAdaptarSi: (p['noAdaptarSi'] ?? p['no_adaptar_si'] ?? '') as string,
    maxAdaptacionesPorPeriodo: (p['maxAdaptacionesPorPeriodo'] ?? p['max_adaptaciones_por_periodo'] ?? 3) as number,
    periodoHoras: (p['periodoHoras'] ?? p['periodo_horas'] ?? 24) as number,
    extraccionVaciaEsFallo: (p['extraccionVaciaEsFallo'] ?? p['extraccion_vacia_es_fallo'] ?? true) as boolean,
  }
}

// ─── Cálculo de próxima ejecución por cron ────────────────────────────────────
// Maneja los patrones más comunes sin dependencias externas.
// Para expresiones complejas, usa +24h como fallback.

export function calcularProximaCron(expresion: string, desde: Date): Date {
  const parts = expresion.trim().split(/\s+/)
  if (parts.length !== 5) return new Date(desde.getTime() + 86_400_000)

  const [, hour] = parts

  // Cada N horas: "0 */N * * *"
  if (hour.startsWith('*/')) {
    const n = parseInt(hour.slice(2), 10)
    if (!isNaN(n) && n >= 1 && n <= 24) {
      return new Date(desde.getTime() + n * 3_600_000)
    }
  }

  // Cada hora: "0 * * * *"
  if (hour === '*') return new Date(desde.getTime() + 3_600_000)

  // Hora fija diaria o semanal: usar 24h
  return new Date(desde.getTime() + 86_400_000)
}
