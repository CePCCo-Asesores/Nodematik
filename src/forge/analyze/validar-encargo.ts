/**
 * Validador determinista para el ENCARGO DE FABRICACIÓN producido por forge-analyze.
 * Traducción de src/forge/skills/forge-analyze/scripts/validar_encargo.py a TypeScript.
 *
 * Principio: verifica por recálculo — no confía en lo declarado.
 */

import type { ResultadoValidacion } from '../extract/types'

const VERBOS_VALIDOS = new Set(['reusar', 'modificar', 'fabricar'])
const NIVELES_GENERALIZACION_VALIDOS = new Set(['cliente', 'vertical', 'universal'])
const VARIABLES_FACTORY_REQUERIDAS = new Set([
  'verbo_central', 'señal_disparo', 'formato_salida', 'complejidad', 'distincion',
])
const NIVELES_RIESGO_VALIDOS = new Set(['bajo', 'medio', 'alto', 'critico'])

// ─── Función principal ────────────────────────────────────────────────────────

export function validarEncargo(encargo: unknown, resultadoExtraccion: unknown): ResultadoValidacion {
  if (!encargo || typeof encargo !== 'object' || Array.isArray(encargo)) {
    return {
      valida: false,
      errores: ['El ENCARGO debe ser un objeto JSON.'],
      advertencias: [],
      requiereRevisionHumana: true,
    }
  }

  const e = encargo as Record<string, unknown>
  const errores: string[] = []
  const advertencias: string[] = []

  const registroIdsDisponibles = extraerRegistroIds(resultadoExtraccion)

  validarDecision(e, errores)
  validarEspecificacionFactory(e, errores, advertencias)
  validarEvidenciaUsada(e, errores, advertencias, registroIdsDisponibles)
  validarNivelGeneralizacion(e, errores, advertencias)
  validarReaprobacion(e, errores)
  validarCoherenciaDatos(e, errores, advertencias)
  validarRiesgoAcumulado(e, errores, advertencias)
  validarSkillObjetivo(e, errores)

  const requiereRevisionHumana = evaluarRevisionHumana(e, errores)

  return {
    valida: errores.length === 0,
    errores,
    advertencias,
    requiereRevisionHumana,
  }
}

// ─── Helpers de extracción ────────────────────────────────────────────────────

function extraerRegistroIds(resultadoExtraccion: unknown): Set<string> {
  if (!resultadoExtraccion || typeof resultadoExtraccion !== 'object' || Array.isArray(resultadoExtraccion)) {
    return new Set()
  }
  const re = resultadoExtraccion as Record<string, unknown>
  const registros = re['registros']
  if (!Array.isArray(registros)) return new Set()

  const ids = new Set<string>()
  for (const r of registros as unknown[]) {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const rid = (r as Record<string, unknown>)['registro_id']
      if (rid) ids.add(String(rid))
    }
  }
  return ids
}

// ─── Validadores parciales ────────────────────────────────────────────────────

function validarDecision(e: Record<string, unknown>, errores: string[]): void {
  const decision = e['decision']
  if (!VERBOS_VALIDOS.has(decision as string)) {
    errores.push(
      `'decision' inválida: '${decision}'. Verbos válidos: ${[...VERBOS_VALIDOS].sort().join(', ')}.`
    )
  }
}

function validarEspecificacionFactory(
  e: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const ef = e['especificacion_factory']
  if (ef === undefined || ef === null) {
    errores.push("'especificacion_factory' es requerida.")
    return
  }
  if (typeof ef !== 'object' || Array.isArray(ef)) {
    errores.push("'especificacion_factory' debe ser un objeto.")
    return
  }

  const efObj = ef as Record<string, unknown>
  const claves = new Set(Object.keys(efObj))
  const faltantes = [...VARIABLES_FACTORY_REQUERIDAS].filter(v => !claves.has(v)).sort()
  if (faltantes.length > 0) {
    errores.push(`'especificacion_factory' le faltan variables requeridas: ${JSON.stringify(faltantes)}.`)
  }

  for (const varName of VARIABLES_FACTORY_REQUERIDAS) {
    const valor = efObj[varName]
    if (valor !== undefined && typeof valor === 'string' && !(valor as string).trim()) {
      advertencias.push(`'especificacion_factory.${varName}' existe pero está vacía.`)
    }
  }
}

function validarEvidenciaUsada(
  e: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
  registroIdsDisponibles: Set<string>,
): void {
  const evidencia = e['evidencia_usada']
  if (evidencia === undefined || evidencia === null) {
    errores.push("'evidencia_usada' es requerida — la trazabilidad causal es una invariante.")
    return
  }
  if (!Array.isArray(evidencia)) {
    errores.push("'evidencia_usada' debe ser una lista.")
    return
  }

  if ((evidencia as unknown[]).length === 0 && registroIdsDisponibles.size > 0) {
    errores.push(
      "'evidencia_usada' está vacía pero hay registros disponibles. " +
      'Cada decisión del encargo debe tener evidencia que la sostenga.'
    )
  }

  const idsCitadosNoEncontrados: string[] = []

  for (let i = 0; i < (evidencia as unknown[]).length; i++) {
    const entry = (evidencia as unknown[])[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errores.push(`'evidencia_usada[${i}]' debe ser un objeto.`)
      continue
    }
    const ev = entry as Record<string, unknown>
    const rid = ev['registro_id']
    if (!rid || typeof rid !== 'string' || !(rid as string).trim()) {
      errores.push(`'evidencia_usada[${i}]' falta 'registro_id' (debe referenciar un registro real).`)
      continue
    }

    if (registroIdsDisponibles.size > 0 && !registroIdsDisponibles.has(rid as string)) {
      idsCitadosNoEncontrados.push(rid as string)
    }

    const razon = ev['razon']
    if (!razon || typeof razon !== 'string' || !(razon as string).trim()) {
      errores.push(
        `'evidencia_usada[${i}]' (registro_id='${rid}') falta 'razon' — ` +
        'explicar por qué ese registro motivó esta decisión.'
      )
    }
  }

  if (idsCitadosNoEncontrados.length > 0) {
    errores.push(
      `evidencia_usada cita registro_ids que no existen en el ResultadoExtraccion: ` +
      `${JSON.stringify(idsCitadosNoEncontrados)}. Revisar la cadena de trazabilidad.`
    )
  }
}

function validarNivelGeneralizacion(
  e: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const nivel = e['nivel_generalizacion']
  if (!NIVELES_GENERALIZACION_VALIDOS.has(nivel as string)) {
    errores.push(
      `'nivel_generalizacion' inválido: '${nivel}'. ` +
      `Válidos: ${[...NIVELES_GENERALIZACION_VALIDOS].sort().join(', ')}.`
    )
    return
  }

  if (nivel === 'universal' && !e['requiere_revision_humana']) {
    errores.push(
      "'nivel_generalizacion: universal' requiere 'requiere_revision_humana: true' — " +
      'un skill universal afecta a todas las organizaciones.'
    )
  }
}

function validarReaprobacion(e: Record<string, unknown>, errores: string[]): void {
  const decision = e['decision']
  const reaprobacion = e['reaprobacion_requerida']

  if (decision === 'modificar' || decision === 'fabricar') {
    if (reaprobacion !== true) {
      errores.push(
        `'reaprobacion_requerida' debe ser true cuando decision='${decision}'. ` +
        'Modificar o fabricar un skill siempre requiere nueva aprobación.'
      )
    }
  }
}

function validarCoherenciaDatos(
  e: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const completo = e['basado_en_datos_completos']
  const faltantes = e['datos_faltantes']

  if (completo === undefined || completo === null) {
    errores.push("'basado_en_datos_completos' (bool) es requerido.")
    return
  }
  if (typeof completo !== 'boolean') {
    errores.push("'basado_en_datos_completos' debe ser booleano.")
    return
  }
  if (!Array.isArray(faltantes) && faltantes !== undefined && faltantes !== null) {
    errores.push("'datos_faltantes' debe ser una lista.")
    return
  }

  const faltantesArr = Array.isArray(faltantes) ? (faltantes as unknown[]) : []

  if (completo === true && faltantesArr.length > 0) {
    errores.push(
      "'basado_en_datos_completos' es true pero 'datos_faltantes' no está vacío. " +
      'Coherencia interna inválida.'
    )
  }
  if (completo === false && faltantesArr.length === 0) {
    advertencias.push(
      "'basado_en_datos_completos' es false pero 'datos_faltantes' está vacío — " +
      'declarar qué datos concretos faltan.'
    )
  }
}

function validarRiesgoAcumulado(
  e: Record<string, unknown>,
  errores: string[],
  advertencias: string[],
): void {
  const ra = e['riesgo_acumulado']
  if (ra === undefined || ra === null) {
    errores.push("'riesgo_acumulado' es requerido.")
    return
  }
  if (typeof ra !== 'object' || Array.isArray(ra)) {
    errores.push("'riesgo_acumulado' debe ser un objeto con campo 'nivel'.")
    return
  }

  const nivel = (ra as Record<string, unknown>)['nivel']
  if (!NIVELES_RIESGO_VALIDOS.has(nivel as string)) {
    errores.push(
      `'riesgo_acumulado.nivel' inválido: '${nivel}'. ` +
      `Válidos: ${[...NIVELES_RIESGO_VALIDOS].sort().join(', ')}.`
    )
  }
}

function validarSkillObjetivo(e: Record<string, unknown>, errores: string[]): void {
  const so = e['skill_objetivo']
  if (so === undefined || so === null) {
    errores.push("'skill_objetivo' (nombre del skill a construir o reusar) es requerido.")
    return
  }
  if (typeof so !== 'string' || !(so as string).trim()) {
    errores.push("'skill_objetivo' debe ser una cadena no vacía en kebab-case.")
  }
}

// ─── Evaluación de revisión humana ────────────────────────────────────────────

function evaluarRevisionHumana(e: Record<string, unknown>, errores: string[]): boolean {
  if (errores.length > 0) return true
  if (e['requiere_revision_humana'] === true) return true

  const decision = e['decision']
  if (decision === 'modificar' || decision === 'fabricar') return true

  const nivelGen = e['nivel_generalizacion']
  if (nivelGen === 'universal') return true

  const ra = (e['riesgo_acumulado'] as Record<string, unknown> | undefined) ?? {}
  const nivelRiesgo = ra['nivel']
  if (nivelRiesgo === 'alto' || nivelRiesgo === 'critico') return true

  return false
}
