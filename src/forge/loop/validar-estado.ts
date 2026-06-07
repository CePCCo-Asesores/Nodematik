/**
 * Validador de coherencia para el EstadoLazo.
 * Traducción de src/forge/skills/forge-loop/scripts/validar_estado.py a TypeScript.
 *
 * Verifica invariantes del estado antes de persistir o ejecutar ráfagas.
 * No valida el contenido de negocio — valida la coherencia estructural.
 */

import type { ResultadoValidacion } from '../extract/types'
import type { EstadoLazo } from './types'

const ESTADOS_OPERATIVOS_VALIDOS = new Set(['activo', 'pausado', 'adaptando', 'detenido'])
const TIPOS_RITMO_VALIDOS = new Set(['cron', 'umbral'])

// ─── Función principal ────────────────────────────────────────────────────────

export function validarEstado(estado: unknown): ResultadoValidacion {
  let d: Record<string, unknown>

  if (estado && typeof estado === 'object' && !Array.isArray(estado)) {
    d = normalizarEstado(estado as EstadoLazo | Record<string, unknown>)
  } else {
    return {
      valida: false,
      errores: ['El estado debe ser un objeto EstadoLazo o un dict equivalente.'],
      advertencias: [],
      requiereRevisionHumana: false,
    }
  }

  const errores: string[] = []
  const advertencias: string[] = []

  validarCamposRequeridos(d, errores)
  validarEstadoOperativo(d, errores, advertencias)
  validarRitmo(d, errores)
  validarTimestamps(d, errores, advertencias)
  validarSkillOperante(d, errores)
  validarCoherenciaAdaptacion(d, errores, advertencias)
  validarCoherenciaFallos(d, errores, advertencias)
  validarPoliticaAdaptacion(d, errores, advertencias)

  return {
    valida: errores.length === 0,
    errores,
    advertencias,
    requiereRevisionHumana: false,
  }
}

// ─── Normalización camelCase → snake_case ─────────────────────────────────────
// El validador trabaja internamente con snake_case para coincidir con los
// nombres de campo usados en el Python de referencia.

function normalizarEstado(estado: EstadoLazo | Record<string, unknown>): Record<string, unknown> {
  // Si ya tiene snake_case (viene de Prisma/DB serializado), devolver directo
  if ('loop_id' in estado) return estado as Record<string, unknown>

  // Si viene en camelCase del tipo EstadoLazo TypeScript, mapear
  const e = estado as Record<string, unknown>
  return {
    loop_id: e['loopId'],
    ficha_id: e['fichaId'],
    org_id: e['orgId'],
    ritmo: e['ritmo'],
    estado_operativo: e['estadoOperativo'],
    ultima_ejecucion: e['ultimaEjecucion'] instanceof Date
      ? (e['ultimaEjecucion'] as Date).toISOString()
      : e['ultimaEjecucion'],
    proxima_ejecucion: e['proximaEjecucion'] instanceof Date
      ? (e['proximaEjecucion'] as Date).toISOString()
      : e['proximaEjecucion'],
    ejecuciones_totales: e['ejecucionesTotales'],
    huella_anterior: e['huellaAnterior'],
    skill_operante: e['skillOperante'],
    fallos_consecutivos: e['fallosConsecutivos'],
    ultima_anomalia: e['ultimaAnomalia'],
    pendiente_aprobacion: e['pendienteAprobacion'],
    politica_adaptacion: e['politicaAdaptacion'],
    cooldown_adaptacion_hasta: e['cooldownAdaptacionHasta'] instanceof Date
      ? (e['cooldownAdaptacionHasta'] as Date).toISOString()
      : e['cooldownAdaptacionHasta'],
    adaptaciones_en_periodo: e['adaptacionesEnPeriodo'],
    historial: e['historial'],
  }
}

// ─── Validadores parciales ────────────────────────────────────────────────────

function validarCamposRequeridos(d: Record<string, unknown>, errores: string[]): void {
  const requeridos = [
    'loop_id', 'ficha_id', 'org_id', 'ritmo',
    'estado_operativo', 'skill_operante', 'politica_adaptacion',
  ]
  for (const campo of requeridos) {
    if (!d[campo]) errores.push(`Campo requerido ausente o vacío: '${campo}'.`)
  }
}

function validarEstadoOperativo(
  d: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const eo = d['estado_operativo']
  if (!ESTADOS_OPERATIVOS_VALIDOS.has(eo as string)) {
    errores.push(
      `'estado_operativo' inválido: '${eo}'. Válidos: ${[...ESTADOS_OPERATIVOS_VALIDOS].sort().join(', ')}.`
    )
    return
  }

  if (eo === 'adaptando' && !d['pendiente_aprobacion']) {
    errores.push(
      "'estado_operativo=adaptando' requiere 'pendiente_aprobacion=true'. " +
      'Un lazo en adaptación siempre espera aprobación humana.'
    )
  }

  if (eo === 'activo' && d['pendiente_aprobacion']) {
    advertencias.push(
      "'estado_operativo=activo' con 'pendiente_aprobacion=true' — " +
      'el lazo no ejecutará hasta que se apruebe. ¿Es intencional?'
    )
  }
}

function validarRitmo(d: Record<string, unknown>, errores: string[]): void {
  const ritmo = d['ritmo']
  if (!ritmo || typeof ritmo !== 'object' || Array.isArray(ritmo)) {
    errores.push("'ritmo' debe ser un objeto.")
    return
  }

  const r = ritmo as Record<string, unknown>
  const tipo = r['tipo']
  if (!TIPOS_RITMO_VALIDOS.has(tipo as string)) {
    errores.push(`'ritmo.tipo' inválido: '${tipo}'. Válidos: ${[...TIPOS_RITMO_VALIDOS].sort().join(', ')}.`)
    return
  }

  if (tipo === 'cron') {
    const valor = r['valor']
    if (!valor || typeof valor !== 'string' || !(valor as string).trim()) {
      errores.push("'ritmo.valor' (expresión cron) es requerido cuando tipo='cron'.")
    }
  } else if (tipo === 'umbral') {
    if (!r['metrica'] || typeof r['metrica'] !== 'string' || !(r['metrica'] as string).trim()) {
      errores.push("'ritmo.metrica' es requerida cuando tipo='umbral'.")
    }
    if (!r['operador'] || typeof r['operador'] !== 'string' || !(r['operador'] as string).trim()) {
      errores.push("'ritmo.operador' es requerido cuando tipo='umbral'.")
    }
  }
}

function validarTimestamps(
  d: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const eo = d['estado_operativo']
  const ritmo = (d['ritmo'] as Record<string, unknown> | undefined) ?? {}

  if (eo === 'activo' && ritmo['tipo'] === 'cron') {
    const prox = d['proxima_ejecucion']
    if (!prox) {
      advertencias.push(
        "'estado_operativo=activo' con 'ritmo.tipo=cron' pero 'proxima_ejecucion' no está seteada. " +
        'El scheduler no la incluirá en la lista de pendientes.'
      )
    }
  }

  for (const campo of ['ultima_ejecucion', 'proxima_ejecucion', 'cooldown_adaptacion_hasta']) {
    const val = d[campo]
    if (val !== undefined && val !== null) {
      if (!esIsoValido(String(val))) {
        errores.push(`'${campo}' no es un timestamp ISO 8601 válido: '${val}'.`)
      }
    }
  }

  const ult = parsearTs(d['ultima_ejecucion'])
  const prox = parsearTs(d['proxima_ejecucion'])
  if (ult && prox && ult > prox) {
    errores.push(
      `'ultima_ejecucion' (${d['ultima_ejecucion']}) es posterior a 'proxima_ejecucion' ` +
      `(${d['proxima_ejecucion']}). El scheduler quedaría en loop inmediato.`
    )
  }
}

function validarSkillOperante(d: Record<string, unknown>, errores: string[]): void {
  const so = d['skill_operante']
  if (!so || typeof so !== 'object' || Array.isArray(so)) {
    errores.push("'skill_operante' debe ser un objeto.")
    return
  }

  const s = so as Record<string, unknown>

  if (!s['name'] || typeof s['name'] !== 'string' || !(s['name'] as string).trim()) {
    errores.push("'skill_operante.name' (kebab-case) es requerido.")
  }

  const version = s['version']
  if (version === undefined || version === null) {
    errores.push("'skill_operante.version' (entero) es requerido.")
  } else if (!Number.isInteger(version) || (version as number) < 1) {
    errores.push(`'skill_operante.version' debe ser entero >= 1, got: '${version}'.`)
  }

  const approvedAt = s['approvedAt'] ?? s['approved_at']
  if (!approvedAt) {
    errores.push("'skill_operante.approved_at' (timestamp ISO) es requerido.")
  } else if (!esIsoValido(String(approvedAt))) {
    errores.push(`'skill_operante.approved_at' no es ISO válido: '${approvedAt}'.`)
  }
}

function validarCoherenciaAdaptacion(
  d: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const eo = d['estado_operativo']
  const ua = d['ultima_anomalia']

  if (eo === 'adaptando' && !ua) {
    advertencias.push(
      "'estado_operativo=adaptando' pero 'ultima_anomalia' está vacía — " +
      'documentar qué deterioro disparó la adaptación.'
    )
  }
}

function validarCoherenciaFallos(
  d: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const fallos = d['fallos_consecutivos']
  if (!Number.isInteger(fallos) || (fallos as number) < 0) {
    errores.push("'fallos_consecutivos' debe ser entero >= 0.")
    return
  }

  if ((fallos as number) >= 3 && d['estado_operativo'] === 'activo') {
    advertencias.push(
      `'fallos_consecutivos=${fallos}' con 'estado_operativo=activo' — ` +
      'el motor debería haber pausado el lazo. Verificar si el motor está funcionando.'
    )
  }
}

function validarPoliticaAdaptacion(
  d: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const pa = d['politica_adaptacion']
  if (!pa || typeof pa !== 'object' || Array.isArray(pa)) {
    errores.push("'politica_adaptacion' debe ser un objeto.")
    return
  }

  const p = pa as Record<string, unknown>
  // Acepta tanto camelCase como snake_case para compatibilidad
  const maxAdapt = p['maxAdaptacionesPorPeriodo'] ?? p['max_adaptaciones_por_periodo']
  if (maxAdapt === undefined || maxAdapt === null) {
    errores.push("'politica_adaptacion.max_adaptaciones_por_periodo' es requerido.")
  } else if (!Number.isInteger(maxAdapt) || (maxAdapt as number) < 1) {
    errores.push("'politica_adaptacion.max_adaptaciones_por_periodo' debe ser entero >= 1.")
  }

  const periodo = p['periodoHoras'] ?? p['periodo_horas']
  if (periodo === undefined || periodo === null) {
    errores.push("'politica_adaptacion.periodo_horas' es requerido.")
  } else if (typeof periodo !== 'number' || (periodo as number) <= 0) {
    errores.push("'politica_adaptacion.periodo_horas' debe ser número > 0.")
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esIsoValido(val: string): boolean {
  if (!val || typeof val !== 'string') return false
  try {
    const d = new Date(val)
    return !isNaN(d.getTime())
  } catch {
    return false
  }
}

function parsearTs(val: unknown): Date | null {
  if (!val || typeof val !== 'string') return null
  const d = new Date(val)
  return isNaN(d.getTime()) ? null : d
}
