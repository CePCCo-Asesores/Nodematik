/**
 * Validador determinista para el PLAN producido por forge-sources.
 * Traducción de src/forge/skills/forge-sources/scripts/validar_plan.py a TypeScript.
 *
 * Principio: DEMUESTRA cobertura recalculando desde cero.
 * No confía en lo que el LLM declara — recalcula y compara.
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ResultadoValidacionPlan {
  valida: boolean
  errores: string[]
  advertencias: string[]
  coberturaRecalculadaPct: number
  datosCubiertosRecalculados: string[]
  datosFaltantesRecalculados: string[]
  requiereRevisionHumana: boolean
}

const ESTADOS_VALIDOS = new Set(['disponible', 'condicional', 'descartada', 'dudosa'])
const METODOS_ACCESO_VALIDOS = new Set(['api', 'feed', 'web', 'archivo_cliente', 'dataset_abierto'])

// Qué clave de 'metadatos' necesita cada metodo_acceso para que el extractor sepa de
// dónde obtener los datos. Re-portado del diseño Python de validar_plan: una fuente
// usable sin estos metadatos es inútil para forge-extract (sabe que es usable pero no
// de dónde extraer). feed/web → url; api → endpoint; archivo_cliente → ruta;
// dataset_abierto → url.
const METADATO_REQUERIDO_POR_METODO: Record<string, string> = {
  feed: 'url',
  web: 'url',
  api: 'endpoint',
  archivo_cliente: 'ruta',
  dataset_abierto: 'url',
}

// ─── Función principal ────────────────────────────────────────────────────────

export function validarPlan(plan: unknown, datosRequeridos: unknown): ResultadoValidacionPlan {
  const drArray = Array.isArray(datosRequeridos)
    ? (datosRequeridos as unknown[]).filter(d => typeof d === 'string' && (d as string).trim()) as string[]
    : []

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return {
      valida: false,
      errores: ['El PLAN debe ser un objeto JSON.'],
      advertencias: [],
      coberturaRecalculadaPct: 0,
      datosCubiertosRecalculados: [],
      datosFaltantesRecalculados: drArray,
      requiereRevisionHumana: true,
    }
  }

  if (drArray.length === 0) {
    return {
      valida: false,
      errores: ["'datos_requeridos' debe ser una lista no vacía para calcular cobertura."],
      advertencias: [],
      coberturaRecalculadaPct: 0,
      datosCubiertosRecalculados: [],
      datosFaltantesRecalculados: [],
      requiereRevisionHumana: true,
    }
  }

  const d = plan as Record<string, unknown>
  const errores: string[] = []
  const advertencias: string[] = []

  let fuentes = d['fuentes']
  if (!Array.isArray(fuentes)) {
    if (fuentes !== undefined) errores.push("'plan.fuentes' debe ser una lista.")
    fuentes = []
  }
  const fuentesArr = fuentes as unknown[]

  const idsVistos = new Set<string>()
  for (let i = 0; i < fuentesArr.length; i++) {
    validarFuente(fuentesArr[i], i, idsVistos, errores, advertencias)
  }

  // Recalcular cobertura desde cero
  const datosReqSet = new Set(drArray)
  const datosCubiertosReales = new Set<string>()

  for (const fuente of fuentesArr) {
    if (!fuente || typeof fuente !== 'object' || Array.isArray(fuente)) continue
    const f = fuente as Record<string, unknown>
    if (f['estado'] !== 'disponible') continue
    const dtc = f['datos_que_cubre']
    if (Array.isArray(dtc)) {
      for (const dato of dtc as unknown[]) {
        const datoStr = String(dato).trim()
        if (datosReqSet.has(datoStr)) datosCubiertosReales.add(datoStr)
      }
    }
  }

  const datosFaltantesReales = [...datosReqSet].filter(d => !datosCubiertosReales.has(d)).sort()
  const coberturaPct = datosReqSet.size > 0
    ? (datosCubiertosReales.size / datosReqSet.size) * 100
    : 0

  // Comparar con cobertura declarada
  const coberturaDeclarada = d['cobertura_pct']
  if (coberturaDeclarada !== undefined && coberturaDeclarada !== null) {
    const declaradaNum = Number(coberturaDeclarada)
    if (isNaN(declaradaNum)) {
      advertencias.push("'plan.cobertura_pct' no es un número válido.")
    } else if (Math.abs(declaradaNum - coberturaPct) > 5) {
      advertencias.push(
        `Cobertura declarada (${declaradaNum.toFixed(1)}%) difiere de la recalculada ` +
        `(${coberturaPct.toFixed(1)}%) en más de 5 puntos porcentuales. Usar la recalculada.`
      )
    }
  }

  // Al menos una fuente disponible
  const fuentesDisponibles = fuentesArr.filter(f =>
    f && typeof f === 'object' && !Array.isArray(f) &&
    (f as Record<string, unknown>)['estado'] === 'disponible'
  )
  if (fuentesDisponibles.length === 0) {
    errores.push("El PLAN no tiene ninguna fuente con estado 'disponible'. No se puede extraer nada.")
  }

  if (datosFaltantesReales.length > 0) {
    advertencias.push(
      `Datos requeridos sin fuente disponible: ${JSON.stringify(datosFaltantesReales)}. ` +
      'Considerar agregar fuentes condicionales o revisar con el cliente.'
    )
  }

  // Fuentes dudosas
  const fuentesDudosas = fuentesArr.filter(f =>
    f && typeof f === 'object' && !Array.isArray(f) &&
    (f as Record<string, unknown>)['estado'] === 'dudosa'
  )
  if (fuentesDudosas.length > 0) {
    const idsDudosas = fuentesDudosas.map((f, i) =>
      ((f as Record<string, unknown>)['id'] as string | undefined) ?? `[${i}]`
    )
    advertencias.push(`Fuentes dudosas que requieren aclaración del cliente: ${JSON.stringify(idsDudosas)}.`)
  }

  const requiereRevisionHumana = evaluarRevisionHumana(d, errores, coberturaPct, fuentesArr)

  return {
    valida: errores.length === 0,
    errores,
    advertencias,
    coberturaRecalculadaPct: Math.round(coberturaPct * 100) / 100,
    datosCubiertosRecalculados: [...datosCubiertosReales].sort(),
    datosFaltantesRecalculados: datosFaltantesReales,
    requiereRevisionHumana,
  }
}

// ─── Validador de fuente individual ──────────────────────────────────────────

function validarFuente(
  fuente: unknown,
  idx: number,
  idsVistos: Set<string>,
  errores: string[],
  advertencias: string[],
): void {
  if (!fuente || typeof fuente !== 'object' || Array.isArray(fuente)) {
    errores.push(`fuentes[${idx}] debe ser un objeto.`)
    return
  }

  const f = fuente as Record<string, unknown>
  const fuenteId = f['id']

  let idStr = ''
  if (!fuenteId || typeof fuenteId !== 'string' || !(fuenteId as string).trim()) {
    errores.push(`fuentes[${idx}] falta campo 'id' (string no vacío, estable y único).`)
  } else {
    idStr = (fuenteId as string).trim()
    if (idsVistos.has(idStr)) {
      errores.push(`fuentes[${idx}] id duplicado: '${idStr}'.`)
    }
    idsVistos.add(idStr)
    if (idStr.startsWith('http://') || idStr.startsWith('https://')) {
      advertencias.push(
        `fuentes['${idStr}'].id parece ser una URL — usar un nombre semántico estable en su lugar.`
      )
    }
  }

  const label = idStr || String(idx)
  const estado = f['estado']
  if (!ESTADOS_VALIDOS.has(estado as string)) {
    errores.push(
      `fuentes['${label}'].estado inválido: '${estado}'. ` +
      `Valores válidos: ${[...ESTADOS_VALIDOS].sort().join(', ')}.`
    )
  }

  const metodo = f['metodo_acceso']
  if (estado === 'disponible' || estado === 'condicional') {
    if (metodo !== undefined && metodo !== null && !METODOS_ACCESO_VALIDOS.has(metodo as string)) {
      errores.push(
        `fuentes['${label}'].metodo_acceso inválido: '${metodo}'. ` +
        `Valores válidos: ${[...METODOS_ACCESO_VALIDOS].sort().join(', ')}.`
      )
    }
    if ((metodo === undefined || metodo === null) && estado === 'disponible') {
      errores.push(`fuentes['${label}'] con estado 'disponible' requiere metodo_acceso.`)
    }

    // Una fuente usable debe traer en 'metadatos' el dato de acceso que su metodo necesita
    // (url/endpoint/ruta), o el extractor no sabrá de dónde extraer. Solo se exige cuando
    // el metodo es válido y conocido.
    if (typeof metodo === 'string' && METADATO_REQUERIDO_POR_METODO[metodo]) {
      const claveReq = METADATO_REQUERIDO_POR_METODO[metodo]
      const metadatos = f['metadatos']
      const metaObj =
        metadatos && typeof metadatos === 'object' && !Array.isArray(metadatos)
          ? (metadatos as Record<string, unknown>)
          : null
      const valor = metaObj ? metaObj[claveReq] : undefined
      if (!valor || typeof valor !== 'string' || !(valor as string).trim()) {
        errores.push(
          `fuentes['${label}'] (metodo '${metodo}') requiere 'metadatos.${claveReq}' ` +
          'para que el extractor sepa de dónde obtener los datos.'
        )
      }
    }
  }

  if (estado === 'disponible') {
    const dtc = f['datos_que_cubre']
    if (!Array.isArray(dtc) || (dtc as unknown[]).length === 0) {
      advertencias.push(
        `fuentes['${label}'] con estado 'disponible' no declara 'datos_que_cubre' — ` +
        'no contribuirá al cálculo de cobertura.'
      )
    }
  }

  if (estado === 'condicional') {
    const rdel = f['requiere_del_cliente']
    if (!rdel || (typeof rdel === 'string' && !(rdel as string).trim())) {
      errores.push(
        `fuentes['${label}'] con estado 'condicional' debe declarar ` +
        "'requiere_del_cliente' — el orquestador necesita saber qué pedirle al cliente."
      )
    }
  }

  if (metodo === 'web' && estado === 'disponible') {
    if (!f['nota_permiso']) {
      advertencias.push(
        `fuentes['${label}'] usa metodo 'web' — documentar verificación de robots.txt ` +
        "y términos de servicio en 'nota_permiso'."
      )
    }
  }
}

// ─── Evaluación de revisión humana ────────────────────────────────────────────

function evaluarRevisionHumana(
  plan: Record<string, unknown>,
  errores: string[],
  coberturaPct: number,
  fuentes: unknown[],
): boolean {
  if (errores.length > 0) return true
  if (coberturaPct < 50) return true

  for (const fuente of fuentes) {
    if (!fuente || typeof fuente !== 'object' || Array.isArray(fuente)) continue
    const riesgo = ((fuente as Record<string, unknown>)['riesgo_fuente'] ?? '') as string
    if (typeof riesgo === 'string' && (riesgo.toLowerCase() === 'alto' || riesgo.toLowerCase() === 'critico')) {
      return true
    }
  }

  if (plan['requiere_revision_humana']) return true

  return false
}
