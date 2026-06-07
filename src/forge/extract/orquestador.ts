/**
 * Orquestador de extracción para forge-extract.
 * Traducción de src/forge/skills/forge-extract/scripts/orquestador.py a TypeScript.
 *
 * Despacha por método de acceso sin conocer las fuentes.
 * Sella registro_id único por registro.
 * Calcula cobertura honestamente: solo cuenta datos de fuentes exitosas.
 *
 * Punto de extensión: los adaptadores se registran con registrarAdaptador()
 * antes de llamar a orquestar(). El backend conecta los adaptadores reales.
 */

import type { Adaptador, FuentePlan, PlanExtraccion, Registro, ResultadoExtraccion } from './types'
import { ahoraIso, sellarRegistroId } from './types'

// ─── Registro de adaptadores ──────────────────────────────────────────────────

const adaptadoresRegistrados = new Map<string, Adaptador>()

export function registrarAdaptador(metodo: string, adaptador: Adaptador): void {
  adaptadoresRegistrados.set(metodo, adaptador)
}

// ─── Función de extensión (tubería) ──────────────────────────────────────────

type FnTuberia = (fuente: FuentePlan, credenciales: Record<string, unknown>) => Promise<Omit<Registro, 'registroId'>[]>

let _correrTuberia: FnTuberia | null = null

export function configurarTuberia(fn: FnTuberia): void {
  _correrTuberia = fn
}

async function correrTuberia(
  fuente: FuentePlan,
  credenciales: Record<string, unknown>,
): Promise<Omit<Registro, 'registroId'>[]> {
  if (_correrTuberia) {
    return _correrTuberia(fuente, credenciales)
  }
  const metodo = fuente.metodoAcceso ?? ''
  const adaptador = adaptadoresRegistrados.get(metodo ?? '')
  if (!adaptador) {
    throw new Error(
      `No hay adaptador registrado para metodo_acceso='${metodo}'. ` +
      'El backend debe registrar el adaptador antes de correr la tubería.'
    )
  }
  return adaptador.obtener(fuente, credenciales)
}

// ─── Orquestador principal ────────────────────────────────────────────────────

export async function orquestar(
  plan: PlanExtraccion,
  credencialesByo: Record<string, unknown> = {},
): Promise<ResultadoExtraccion> {
  const fuentes = plan.fuentes ?? []
  const datosRequeridos = plan.datosRequeridos ?? []
  const datosReqSet = new Set(datosRequeridos)

  const registrosTotales: Registro[] = []
  const fuentesUsadas: string[] = []
  const fuentesOmitidas: string[] = []
  const datosCubiertosSet = new Set<string>()

  let registroGlobalCounter = 0

  for (let srcIdx = 0; srcIdx < fuentes.length; srcIdx++) {
    const fuente = fuentes[srcIdx]
    const fuenteId = fuente.id
    const estado = fuente.estado

    // Omitir descartadas y dudosas
    if (estado === 'descartada' || estado === 'dudosa') {
      fuentesOmitidas.push(fuenteId)
      continue
    }

    // Omitir condicional sin credencial
    if (estado === 'condicional' && !(fuenteId in credencialesByo)) {
      fuentesOmitidas.push(fuenteId)
      continue
    }

    // Intentar extracción
    let registrosFuente: Omit<Registro, 'registroId'>[]
    try {
      registrosFuente = await correrTuberia(fuente, credencialesByo)
    } catch {
      fuentesOmitidas.push(fuenteId)
      continue
    }

    if (registrosFuente.length === 0) {
      // Sin registros no es error — el adaptador decidió que no había datos.
      // Se registra como fuente usada si no lanzó excepción.
      fuentesUsadas.push(fuenteId)
      continue
    }

    // Sellar registro_id y acumular (N base-1, M base-0 global)
    const srcN = srcIdx + 1
    for (const registroSinId of registrosFuente) {
      const registro = sellarRegistroId(registroSinId, srcN, registroGlobalCounter)
      registroGlobalCounter++
      registrosTotales.push(registro)

      for (const dato of registro.datosCubiertos) {
        if (datosReqSet.has(dato)) datosCubiertosSet.add(dato)
      }
    }

    fuentesUsadas.push(fuenteId)
  }

  const datosCubiertos = [...datosCubiertosSet].sort()
  const datosFaltantes = [...datosReqSet].filter(d => !datosCubiertosSet.has(d)).sort()
  const coberturaPct = datosReqSet.size > 0
    ? Math.round((datosCubiertosSet.size / datosReqSet.size) * 10_000) / 100
    : 0

  return {
    registros: registrosTotales,
    fuentesUsadas,
    fuentesOmitidas,
    coberturaPct,
    datosCubiertos,
    datosFaltantes,
    requiereRevisionHumana: Boolean(plan.requiereRevisionHumana),
    extraidoEn: ahoraIso(),
  }
}
