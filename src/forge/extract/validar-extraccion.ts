/**
 * Validador determinista para el ResultadoExtraccion producido por el orquestador.
 * Traducción de src/forge/skills/forge-extract/scripts/validar_extraccion.py a TypeScript.
 *
 * Principio: verifica honestidad recalculando — no confía en lo declarado.
 */

import type { ResultadoValidacion } from './types'

// ─── Tipos de salida extendidos ───────────────────────────────────────────────

export interface ResultadoValidacionExtraccion extends ResultadoValidacion {
  coberturaRecalculadaPct: number
  registrosInvalidos: number[]
}

const METODOS_ACCESO_VALIDOS = new Set(['api', 'feed', 'web', 'archivo_cliente', 'dataset_abierto'])
const PATRON_REGISTRO_ID = /^src-\d+:r\d+$/

// ─── Función principal ────────────────────────────────────────────────────────

export function validarExtraccion(
  resultado: unknown,
  datosRequeridos: unknown,
): ResultadoValidacionExtraccion {
  if (!resultado || typeof resultado !== 'object' || Array.isArray(resultado)) {
    return {
      valida: false,
      errores: ['ResultadoExtraccion debe ser un objeto JSON.'],
      advertencias: [],
      coberturaRecalculadaPct: 0,
      registrosInvalidos: [],
      requiereRevisionHumana: true,
    }
  }

  const r = resultado as Record<string, unknown>
  const errores: string[] = []
  const advertencias: string[] = []
  const registrosInvalidos: number[] = []

  const datosReqSet = new Set<string>(
    Array.isArray(datosRequeridos)
      ? (datosRequeridos as unknown[])
          .filter(d => typeof d === 'string' && (d as string).trim())
          .map(d => (d as string).trim())
      : []
  )

  let registros = r['registros']
  if (!Array.isArray(registros)) {
    if (registros !== undefined) errores.push("'registros' debe ser una lista.")
    registros = []
  }
  const registrosArr = registros as unknown[]

  const registroIdsVistos = new Set<string>()
  const datosCubiertosReales = new Set<string>()

  for (let i = 0; i < registrosArr.length; i++) {
    const invalido = validarRegistro(registrosArr[i], i, registroIdsVistos, errores, advertencias)
    if (invalido) {
      registrosInvalidos.push(i)
      continue
    }
    const reg = registrosArr[i] as Record<string, unknown>
    const dtc = reg['datos_cubiertos']
    if (Array.isArray(dtc)) {
      for (const dato of dtc as unknown[]) {
        const datoStr = String(dato).trim()
        if (datosReqSet.has(datoStr)) datosCubiertosReales.add(datoStr)
      }
    }
  }

  const coberturaRecalculada = datosReqSet.size > 0
    ? (datosCubiertosReales.size / datosReqSet.size) * 100
    : 0

  // Comparar con lo declarado
  const coberturaDeclarada = r['cobertura_pct']
  if (coberturaDeclarada !== undefined && coberturaDeclarada !== null) {
    const declaradaNum = Number(coberturaDeclarada)
    if (isNaN(declaradaNum)) {
      advertencias.push("'cobertura_pct' declarada no es un número válido.")
    } else if (Math.abs(declaradaNum - coberturaRecalculada) > 5) {
      advertencias.push(
        `Cobertura declarada (${declaradaNum.toFixed(1)}%) difiere de la recalculada ` +
        `(${coberturaRecalculada.toFixed(1)}%) en más de 5 puntos. ` +
        'El orquestador puede tener un bug en el cálculo.'
      )
    }
  }

  // Verificar datos_faltantes declarados vs recalculados
  const datosFaltantesDeclarados = new Set<string>(
    Array.isArray(r['datos_faltantes'])
      ? (r['datos_faltantes'] as unknown[]).map(d => String(d))
      : []
  )
  const datosFaltantesReales = new Set([...datosReqSet].filter(d => !datosCubiertosReales.has(d)))

  if (datosReqSet.size > 0) {
    const declaradosStr = [...datosFaltantesDeclarados].sort().join(',')
    const realesStr = [...datosFaltantesReales].sort().join(',')
    if (declaradosStr !== realesStr) {
      advertencias.push(
        `Datos faltantes declarados ${JSON.stringify([...datosFaltantesDeclarados].sort())} no coinciden ` +
        `con los recalculados ${JSON.stringify([...datosFaltantesReales].sort())}.`
      )
    }
  }

  // Verificar fuentes_usadas coherentes con registros
  const fuentesEnRegistros = new Set(
    registrosArr
      .filter(reg => reg && typeof reg === 'object' && !Array.isArray(reg))
      .map(reg => (reg as Record<string, unknown>)['fuente'])
      .filter(f => f)
      .map(f => String(f))
  )
  const fuentesUsadasDeclaradas = new Set<string>(
    Array.isArray(r['fuentes_usadas'])
      ? (r['fuentes_usadas'] as unknown[]).map(f => String(f))
      : []
  )
  const fuentesExtras = [...fuentesEnRegistros].filter(f => !fuentesUsadasDeclaradas.has(f))
  if (fuentesExtras.length > 0) {
    advertencias.push(
      `Registros referencian fuentes no declaradas en fuentes_usadas: ${JSON.stringify(fuentesExtras)}.`
    )
  }

  if (!r['extraido_en']) {
    errores.push("'extraido_en' (timestamp ISO) es requerido.")
  }

  const requiereRevisionHumana = Boolean(r['requiere_revision_humana']) || errores.length > 0

  return {
    valida: errores.length === 0,
    errores,
    advertencias,
    coberturaRecalculadaPct: Math.round(coberturaRecalculada * 100) / 100,
    registrosInvalidos,
    requiereRevisionHumana,
  }
}

// ─── Validador de registro individual ────────────────────────────────────────

function validarRegistro(
  registro: unknown,
  idx: number,
  idsVistos: Set<string>,
  errores: string[],
  advertencias: string[],
): boolean {
  if (!registro || typeof registro !== 'object' || Array.isArray(registro)) {
    errores.push(`registros[${idx}] debe ser un objeto.`)
    return true
  }

  const reg = registro as Record<string, unknown>
  let invalido = false

  const rid = (reg['registro_id'] ?? '') as string
  if (!rid) {
    errores.push(`registros[${idx}] falta 'registro_id'.`)
    invalido = true
  } else if (!PATRON_REGISTRO_ID.test(rid)) {
    errores.push(`registros[${idx}].registro_id '${rid}' no sigue el formato 'src-N:rM'.`)
    invalido = true
  } else if (idsVistos.has(rid)) {
    errores.push(`registros[${idx}].registro_id '${rid}' duplicado.`)
    invalido = true
  } else {
    idsVistos.add(rid)
  }

  const contenido = reg['contenido']
  if (typeof contenido !== 'string' || !(contenido as string).trim()) {
    errores.push(`registros[${idx}] (id='${rid}') 'contenido' no puede estar vacío.`)
    invalido = true
  }

  const fuente = reg['fuente']
  if (typeof fuente !== 'string' || !(fuente as string).trim()) {
    errores.push(`registros[${idx}] (id='${rid}') falta 'fuente'.`)
    invalido = true
  }

  const metodo = reg['metodo_acceso']
  if (!METODOS_ACCESO_VALIDOS.has(metodo as string)) {
    errores.push(`registros[${idx}] (id='${rid}') metodo_acceso '${metodo}' inválido.`)
    invalido = true
  }

  const dtc = reg['datos_cubiertos']
  if (!Array.isArray(dtc)) {
    errores.push(`registros[${idx}] (id='${rid}') 'datos_cubiertos' debe ser una lista.`)
    invalido = true
  }

  if (!reg['obtenido_en']) {
    advertencias.push(`registros[${idx}] (id='${rid}') falta 'obtenido_en' (timestamp).`)
  }

  return invalido
}
