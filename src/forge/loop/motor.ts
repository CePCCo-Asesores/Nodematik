/**
 * Motor del lazo continuo forge-loop.
 * Traducción de src/forge/skills/forge-loop/scripts/motor_lazo.py a TypeScript.
 *
 * Implementa la lógica de ejecución en ráfagas, detección de cambios,
 * frenos anti-hiperactividad y coordinación con el scheduler.
 *
 * Punto de extensión principal: configurarTuberia() conecta el orquestador
 * real de forge-extract. El BullMQ scheduler llama tickScheduler().
 */

import { createHash } from 'node:crypto'

import type {
  AlmacenEstado,
  EntradaHistorial,
  EstadoLazo,
  Huella,
  ResultadoRafaga,
} from './types'

// ─── Constantes ───────────────────────────────────────────────────────────────

export const MAX_FALLOS_CONSECUTIVOS = 3

// ─── Tubería de extracción (punto de extensión) ───────────────────────────────

type FnTuberia = (loopId: string, fichaId: string, orgId: string) => Promise<Record<string, unknown>>

let _correrTuberia: FnTuberia | null = null

export function configurarTuberia(fn: FnTuberia): void {
  _correrTuberia = fn
}

// ─── Ejecución de ráfaga ─────────────────────────────────────────────────────

export async function ejecutarRafaga(
  loopId: string,
  almacen: AlmacenEstado,
): Promise<ResultadoRafaga> {
  const estado = await almacen.cargarConLock(loopId)
  if (estado === null) {
    return { ejecutado: false, evento: 'bloqueado', detalle: 'lazo bloqueado por otra instancia' }
  }

  try {
    return await procesarRafaga(estado)
  } finally {
    await almacen.guardarYLiberar(estado)
  }
}

async function procesarRafaga(estado: EstadoLazo): Promise<ResultadoRafaga> {
  if (estado.estadoOperativo !== 'activo') {
    return {
      ejecutado: false,
      evento: 'omitido',
      detalle: `estado_operativo='${estado.estadoOperativo}' — no activo`,
    }
  }
  if (estado.pendienteAprobacion) {
    return {
      ejecutado: false,
      evento: 'omitido',
      detalle: 'pendiente_aprobacion=true — esperando aprobación humana',
    }
  }

  const ahora = new Date()

  let resultadoExtraccion: Record<string, unknown>
  try {
    if (!_correrTuberia) {
      throw new Error(
        'La tubería no está configurada. El backend debe llamar configurarTuberia() ' +
        'antes de ejecutar ráfagas.'
      )
    }
    resultadoExtraccion = await _correrTuberia(estado.loopId, estado.fichaId, estado.orgId)
  } catch (exc) {
    return manejarExcepcion(estado, ahora, String(exc))
  }

  const registros = (resultadoExtraccion['registros'] as unknown[] | undefined) ?? []
  const esVacia = registros.length === 0

  if (esVacia) {
    const politica = estado.politicaAdaptacion
    if (politica.extraccionVaciaEsFallo) {
      return manejarExcepcion(estado, ahora, 'extracción devolvió 0 registros (política: es fallo)')
    }
    registrarEvento(estado, ahora, 'extraccion_vacia', 'sin registros (esperado por política)')
    actualizarTemporalizacion(estado, ahora)
    estado.ejecucionesTotales += 1
    return {
      ejecutado: true,
      evento: 'extraccion_vacia_ok',
      detalle: 'sin registros — esperado por política de monitoreo de ausencia',
    }
  }

  const huellaNueva = calcularHuella(resultadoExtraccion)
  const huellaAnterior = estado.huellaAnterior

  estado.fallosConsecutivos = 0
  estado.ejecucionesTotales += 1
  estado.ultimaAnomalia = null

  const deterioro = detectarDeterio(huellaAnterior, huellaNueva)

  if (deterioro) {
    return intentarAdaptacion(estado, ahora, deterioro)
  }

  estado.huellaAnterior = huellaNueva
  registrarEvento(estado, ahora, 'ejecucion_ok', `${registros.length} registros obtenidos`)
  actualizarTemporalizacion(estado, ahora)

  return {
    ejecutado: true,
    evento: 'ejecucion_ok',
    detalle: `${registros.length} registros procesados`,
  }
}

// ─── Manejo de excepciones ────────────────────────────────────────────────────

function manejarExcepcion(estado: EstadoLazo, ahora: Date, detalle: string): ResultadoRafaga {
  estado.fallosConsecutivos += 1
  estado.ultimaAnomalia = { tipo: 'excepcion', detalle, ts: ahora.toISOString() }
  registrarEvento(estado, ahora, 'fallo', detalle)

  if (estado.fallosConsecutivos >= MAX_FALLOS_CONSECUTIVOS) {
    estado.estadoOperativo = 'pausado'
    registrarEvento(
      estado, ahora, 'pausa_por_fallos',
      `alcanzó ${MAX_FALLOS_CONSECUTIVOS} fallos consecutivos`
    )
    return {
      ejecutado: true,
      evento: 'pausa_por_fallos',
      detalle: `lazo pausado tras ${MAX_FALLOS_CONSECUTIVOS} fallos: ${detalle}`,
    }
  }

  actualizarTemporalizacion(estado, ahora)
  return { ejecutado: true, evento: 'fallo', detalle }
}

// ─── Adaptación ───────────────────────────────────────────────────────────────

function intentarAdaptacion(estado: EstadoLazo, ahora: Date, razon: string): ResultadoRafaga {
  const politica = estado.politicaAdaptacion

  // Freno 1: cooldown
  if (estado.cooldownAdaptacionHasta && ahora < estado.cooldownAdaptacionHasta) {
    registrarEvento(estado, ahora, 'adaptacion_frenada_cooldown', razon)
    actualizarTemporalizacion(estado, ahora)
    return { ejecutado: true, evento: 'adaptacion_frenada_cooldown', detalle: razon }
  }

  // Freno 2: techo del período
  const conteo = actualizarConteoPeriodo(estado, ahora, politica)
  if (conteo > politica.maxAdaptacionesPorPeriodo) {
    estado.estadoOperativo = 'pausado'
    const diag = 'adapta_sin_estabilizarse'
    registrarEvento(estado, ahora, 'pausa_por_adaptaciones', diag)
    return {
      ejecutado: true,
      evento: 'pausa_por_adaptaciones',
      detalle: `superó ${politica.maxAdaptacionesPorPeriodo} adaptaciones en ${politica.periodoHoras}h: ${diag}`,
    }
  }

  // Puede adaptar
  estado.estadoOperativo = 'adaptando'
  estado.pendienteAprobacion = true
  estado.ultimaAnomalia = { tipo: 'deterioro', detalle: razon, ts: ahora.toISOString() }

  const cooldownMs = (politica.periodoHoras / 4) * 3_600_000
  estado.cooldownAdaptacionHasta = new Date(ahora.getTime() + cooldownMs)
  registrarEvento(estado, ahora, 'adaptacion_iniciada', razon)

  return {
    ejecutado: true,
    evento: 'adaptacion_iniciada',
    detalle: `deterioro detectado — esperando forge-analyze+factory: ${razon}`,
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export async function tickScheduler(almacen: AlmacenEstado): Promise<string[]> {
  return almacen.listarPendientes()
}

// ─── Cálculo de huella ────────────────────────────────────────────────────────

function calcularHuella(resultado: Record<string, unknown>): Huella {
  const registros = (resultado['registros'] as Record<string, unknown>[] | undefined) ?? []
  const contenidos = registros.map(r => String(r['contenido'] ?? '')).sort()
  const contenidoConcat = contenidos.join('\n---\n')
  const contenidoHash = createHash('sha256').update(contenidoConcat, 'utf8').digest('hex').slice(0, 16)

  // El orquestador devuelve coberturaPct (camelCase); aceptar snake_case por retrocompatibilidad.
  const cobertura = Number(resultado['coberturaPct'] ?? resultado['cobertura_pct'] ?? 0)
  const fuentes = [...new Set(
    registros.map(r => String(r['fuente'] ?? '')).filter(Boolean)
  )].sort()

  return { contenidoHash, coberturaPct: cobertura, fuentesActivas: fuentes }
}

function detectarDeterio(anterior: Huella | null, nueva: Huella): string {
  if (!anterior) return ''  // Primera ejecución — sin baseline

  // Caída de cobertura > 30 puntos
  if (anterior.coberturaPct > 0 && nueva.coberturaPct < anterior.coberturaPct - 30) {
    const caida = (anterior.coberturaPct - nueva.coberturaPct).toFixed(1)
    return (
      `cobertura cayó de ${anterior.coberturaPct.toFixed(1)}% a ${nueva.coberturaPct.toFixed(1)}% ` +
      `(caída de ${caida} puntos)`
    )
  }

  // Todas las fuentes activas murieron
  if (anterior.fuentesActivas.length > 0 && nueva.fuentesActivas.length === 0) {
    return `todas las fuentes activas dejaron de responder: ${JSON.stringify(anterior.fuentesActivas)}`
  }

  // Más del 50% de las fuentes activas desaparecieron
  if (anterior.fuentesActivas.length > 0) {
    const prevSet = new Set(anterior.fuentesActivas)
    const nuevaSet = new Set(nueva.fuentesActivas)
    const perdidas = anterior.fuentesActivas.filter(f => !nuevaSet.has(f))
    const pctPerdidas = perdidas.length / prevSet.size
    if (pctPerdidas > 0.5) {
      return `perdió más del 50% de las fuentes activas: ${JSON.stringify(perdidas.sort())}`
    }
  }

  return ''
}

// ─── Helpers de estado ────────────────────────────────────────────────────────

function registrarEvento(estado: EstadoLazo, ts: Date, evento: string, detalle: string): void {
  const entrada: EntradaHistorial = { ts: ts.toISOString(), evento, detalle }
  estado.historial.push(entrada)
  if (estado.historial.length > 100) {
    estado.historial = estado.historial.slice(-100)
  }
}

function actualizarTemporalizacion(estado: EstadoLazo, ahora: Date): void {
  estado.ultimaEjecucion = ahora

  const ritmo = estado.ritmo
  if (ritmo.tipo === 'cron' || ritmo.tipo === 'umbral') {
    // Para cron: el backend (node-cron / BullMQ) calcula la próxima ejecución al persistir.
    // Para umbral: el scheduler evalúa en cada tick.
    // En ambos casos dejamos proximaEjecucion en null para que el backend la recalcule.
    estado.proximaEjecucion = null
  }
}

function actualizarConteoPeriodo(
  estado: EstadoLazo,
  ahora: Date,
  politica: EstadoLazo['politicaAdaptacion'],
): number {
  const ap = estado.adaptacionesEnPeriodo
  let inicioStr = ap.periodoInicio
  let count = ap.count

  if (inicioStr) {
    try {
      const inicio = new Date(inicioStr)
      const transcurridoMs = ahora.getTime() - inicio.getTime()
      if (transcurridoMs > politica.periodoHoras * 3_600_000) {
        inicioStr = ahora.toISOString()
        count = 0
      }
    } catch {
      inicioStr = ahora.toISOString()
      count = 0
    }
  } else {
    inicioStr = ahora.toISOString()
    count = 0
  }

  count += 1
  estado.adaptacionesEnPeriodo = { periodoInicio: inicioStr, count }
  return count
}
