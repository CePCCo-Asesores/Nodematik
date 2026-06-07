/**
 * Validador determinista para la FICHA producida por forge-intake.
 * Traducción de src/forge/skills/forge-intake/scripts/validar_ficha.py a TypeScript.
 *
 * Contrato:
 *   validarFicha(ficha: unknown) -> ResultadoValidacionFicha
 *
 * No lanza excepciones. Errores de parseo se reportan en errores[].
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ResultadoValidacionFicha {
  valida: boolean
  errores: string[]
  advertencias: string[]
  requiereRevisionHumana: boolean
}

const TIPOS_ACCION_VALIDOS = new Set([
  'diagnostico', 'planificacion', 'ejecucion', 'monitoreo', 'creacion_capacidad',
])

const NIVELES_RIESGO_VALIDOS = new Set(['bajo', 'medio', 'alto', 'critico'])

const TIPOS_TEMPORAL_VALIDOS = new Set(['unico', 'continuo'])

const CAMPOS_REQUERIDOS = [
  'objetivo', 'datos_requeridos', 'fuentes_candidatas', 'eje_temporal',
  'entregable', 'pasos', 'tipo_de_accion', 'riesgo_operativo',
  'suficiencia', 'faltantes', 'skill_destino_sugerido',
]

// ─── Función principal ────────────────────────────────────────────────────────

export function validarFicha(ficha: unknown): ResultadoValidacionFicha {
  if (!ficha || typeof ficha !== 'object' || Array.isArray(ficha)) {
    return {
      valida: false,
      errores: ['La FICHA debe ser un objeto JSON, no un tipo primitivo.'],
      advertencias: [],
      requiereRevisionHumana: true,
    }
  }

  const d = ficha as Record<string, unknown>
  const errores: string[] = []
  const advertencias: string[] = []

  for (const campo of CAMPOS_REQUERIDOS) {
    if (!(campo in d)) {
      errores.push(`Campo requerido ausente: '${campo}'.`)
    }
  }

  validarObjetivo(d, errores, advertencias)
  validarDatosRequeridos(d, errores, advertencias)
  validarFuentesCandidatas(d, errores, advertencias)
  validarEjeTemporal(d, errores, advertencias)
  validarPasos(d, errores, advertencias)
  validarTipoDeAccion(d, errores, advertencias)
  validarRiesgoOperativo(d, errores, advertencias)
  validarSuficienciaYFaltantes(d, errores, advertencias)
  validarSkillDestinoSugerido(d, errores, advertencias)

  const requiereRevisionHumana = evaluarRevisionHumana(d, errores)

  return {
    valida: errores.length === 0,
    errores,
    advertencias,
    requiereRevisionHumana,
  }
}

// ─── Validadores parciales ────────────────────────────────────────────────────

function validarObjetivo(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const objetivo = d['objetivo']
  if (objetivo === undefined) return
  if (typeof objetivo !== 'string' || !objetivo.trim()) {
    errores.push("'objetivo' debe ser una cadena no vacía.")
  } else if (objetivo.trim().length < 10) {
    advertencias.push("'objetivo' parece demasiado corto — verificar que describe el resultado esperado.")
  }
}

function validarDatosRequeridos(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const dr = d['datos_requeridos']
  if (dr === undefined) return
  if (!Array.isArray(dr)) {
    errores.push("'datos_requeridos' debe ser una lista.")
    return
  }
  if (dr.length === 0) {
    errores.push("'datos_requeridos' no puede estar vacía — al menos un dato debe estar declarado.")
  }
  for (let i = 0; i < dr.length; i++) {
    if (typeof dr[i] !== 'string' || !(dr[i] as string).trim()) {
      errores.push(`'datos_requeridos[${i}]' debe ser una cadena no vacía.`)
    }
  }
}

function validarFuentesCandidatas(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const fc = d['fuentes_candidatas']
  if (fc === undefined) return
  if (!Array.isArray(fc)) {
    errores.push("'fuentes_candidatas' debe ser una lista.")
    return
  }
  if (fc.length === 0) {
    advertencias.push("'fuentes_candidatas' está vacía — forge-sources no tendrá candidatos para evaluar.")
  }
}

function validarEjeTemporal(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const et = d['eje_temporal']
  if (et === undefined) return
  if (!et || typeof et !== 'object' || Array.isArray(et)) {
    errores.push("'eje_temporal' debe ser un objeto con al menos el campo 'tipo'.")
    return
  }

  const etObj = et as Record<string, unknown>
  const tipo = etObj['tipo']

  if (!TIPOS_TEMPORAL_VALIDOS.has(tipo as string)) {
    errores.push(
      `'eje_temporal.tipo' inválido: '${tipo}'. Valores válidos: ${[...TIPOS_TEMPORAL_VALIDOS].sort().join(', ')}.`
    )
    return
  }

  if (tipo === 'continuo') {
    const ritmo = etObj['ritmo']
    if (!ritmo || typeof ritmo !== 'string' || !(ritmo as string).trim()) {
      errores.push(
        "'eje_temporal.ritmo' es requerido cuando tipo='continuo'. " +
        "Ejemplos: 'diario', 'semanal', 'cada 6h'."
      )
    }
  }
}

function validarPasos(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const pasos = d['pasos']
  if (pasos === undefined) return
  if (!Array.isArray(pasos)) {
    errores.push("'pasos' debe ser una lista.")
    return
  }
  if (pasos.length === 0) {
    advertencias.push("'pasos' está vacía — el pipeline no sabrá qué pasos ejecutar.")
  }
  for (let i = 0; i < pasos.length; i++) {
    const paso = pasos[i]
    if (!paso || typeof paso !== 'object' || Array.isArray(paso)) {
      errores.push(`'pasos[${i}]' debe ser un objeto con campos 'descripcion' y 'tipo'.`)
      continue
    }
    const p = paso as Record<string, unknown>
    if (!('descripcion' in p)) {
      errores.push(`'pasos[${i}]' falta el campo 'descripcion'.`)
    }
    const tipoPaso = p['tipo']
    if (tipoPaso !== 'mecanico' && tipoPaso !== 'con-juicio') {
      errores.push(
        `'pasos[${i}].tipo' inválido: '${tipoPaso}'. Valores válidos: 'mecanico', 'con-juicio'.`
      )
    }
  }
}

function validarTipoDeAccion(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const ta = d['tipo_de_accion']
  if (ta === undefined) return
  if (!TIPOS_ACCION_VALIDOS.has(ta as string)) {
    errores.push(
      `'tipo_de_accion' inválido: '${ta}'. Valores válidos: ${[...TIPOS_ACCION_VALIDOS].sort().join(', ')}.`
    )
  }
}

function validarRiesgoOperativo(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const ro = d['riesgo_operativo']
  if (ro === undefined) return
  if (!ro || typeof ro !== 'object' || Array.isArray(ro)) {
    errores.push("'riesgo_operativo' debe ser un objeto con campos 'nivel', 'requiere_aprobacion', 'razon'.")
    return
  }

  const r = ro as Record<string, unknown>
  const nivel = r['nivel']
  if (!NIVELES_RIESGO_VALIDOS.has(nivel as string)) {
    errores.push(
      `'riesgo_operativo.nivel' inválido: '${nivel}'. Valores válidos: ${[...NIVELES_RIESGO_VALIDOS].sort().join(', ')}.`
    )
  }

  if (!('requiere_aprobacion' in r)) {
    errores.push("'riesgo_operativo.requiere_aprobacion' (bool) es requerido.")
  } else if (typeof r['requiere_aprobacion'] !== 'boolean') {
    errores.push("'riesgo_operativo.requiere_aprobacion' debe ser booleano.")
  }

  const razon = r['razon']
  if (!razon || typeof razon !== 'string' || !(razon as string).trim()) {
    errores.push("'riesgo_operativo.razon' es requerida y debe ser una cadena no vacía.")
  }

  if ((nivel === 'alto' || nivel === 'critico') && r['requiere_aprobacion'] === false) {
    advertencias.push(
      `Riesgo nivel '${nivel}' con requiere_aprobacion=false — verificar si esta combinación es intencional.`
    )
  }
}

function validarSuficienciaYFaltantes(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const suficiencia = d['suficiencia']
  const faltantes = d['faltantes']

  if (suficiencia === undefined) return

  if (typeof suficiencia !== 'boolean') {
    errores.push("'suficiencia' debe ser booleano (true o false).")
    return
  }

  if (faltantes !== undefined && faltantes !== null && !Array.isArray(faltantes)) {
    errores.push("'faltantes' debe ser una lista.")
    return
  }

  if (suficiencia === false) {
    const faltantesArr = (Array.isArray(faltantes) ? faltantes : []) as unknown[]
    if (faltantesArr.length === 0) {
      errores.push(
        "'suficiencia' es false pero 'faltantes' está vacío. " +
        "Declarar al menos una pregunta concreta sobre lo que falta."
      )
    }
  }

  if (suficiencia === true && Array.isArray(faltantes) && (faltantes as unknown[]).length > 0) {
    advertencias.push("'suficiencia' es true pero 'faltantes' tiene elementos — verificar coherencia.")
  }
}

function validarSkillDestinoSugerido(d: Record<string, unknown>, errores: string[], advertencias: string[]): void {
  const sd = d['skill_destino_sugerido']
  if (sd === undefined) return
  if (!sd || typeof sd !== 'object' || Array.isArray(sd)) {
    errores.push("'skill_destino_sugerido' debe ser un objeto con campos 'nombre', 'razon', 'fallback'.")
    return
  }

  const s = sd as Record<string, unknown>
  // nombre puede ser null cuando ningún skill aplica y el fallback es factory/humano.
  const nombre = s['nombre']
  if (nombre !== null && nombre !== undefined) {
    if (typeof nombre !== 'string' || !(nombre as string).trim()) {
      errores.push("'skill_destino_sugerido.nombre' debe ser una cadena no vacía si se proporciona (o null).")
    }
  }

  const razon = s['razon']
  if (!razon || typeof razon !== 'string' || !(razon as string).trim()) {
    errores.push("'skill_destino_sugerido.razon' es requerida.")
  }

  const fallback = s['fallback']
  if (fallback !== undefined && fallback !== null) {
    if (typeof fallback !== 'string' || !(fallback as string).trim()) {
      advertencias.push("'skill_destino_sugerido.fallback' existe pero no es una cadena válida.")
    }
  }
}

// ─── Evaluación de revisión humana ────────────────────────────────────────────

function evaluarRevisionHumana(d: Record<string, unknown>, errores: string[]): boolean {
  if (errores.length > 0) return true

  const ro = (d['riesgo_operativo'] as Record<string, unknown> | undefined) ?? {}
  const nivel = ro['nivel'] as string | undefined
  const requiereAprobacion = ro['requiere_aprobacion']

  if (nivel === 'alto' || nivel === 'critico') return true
  if (requiereAprobacion === true) return true

  const tipoAccion = d['tipo_de_accion']
  if (tipoAccion === 'ejecucion') return true

  const et = (d['eje_temporal'] as Record<string, unknown> | undefined) ?? {}
  if (et['tipo'] === 'continuo' && nivel === 'medio') return true

  return false
}
