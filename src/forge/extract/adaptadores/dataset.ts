/**
 * Adaptador de extracción para datasets abiertos (metodo_acceso='dataset_abierto').
 * Traducción de src/forge/skills/forge-extract/scripts/adaptador_dataset.py a TypeScript.
 *
 * Descarga datasets públicos desde URL (CSV o JSON).
 * No requiere credenciales — los datasets abiertos son accesibles públicamente.
 */

import type { Adaptador, FuentePlan, Registro } from '../types'
import { ahoraIso } from '../types'

const USER_AGENT = 'ForgeExtract/1.0 (+https://nodematik.app)'
const MAX_BYTES = 10 * 1024 * 1024  // 10 MB

// ─── Adaptador ────────────────────────────────────────────────────────────────

export const AdaptadorDataset: Adaptador = {
  async obtener(fuente: FuentePlan, _credenciales: Record<string, unknown>): Promise<Omit<Registro, 'registroId'>[]> {
    const fuenteId = fuente.id
    const metadatos = (fuente.metadatos ?? {}) as Record<string, unknown>
    const url = ((metadatos['url'] as string | undefined) ?? '').trim()

    if (!url) {
      throw new Error(`fuente '${fuenteId}' tipo 'dataset_abierto' requiere metadatos.url.`)
    }

    const { contenido, contentType } = await descargar(url)
    const datosCubiertos = fuente.datosQueCubre ?? []
    const ts = ahoraIso()
    const formato = detectarFormato(url, contentType)

    if (formato === 'csv') {
      return csvARegistros(contenido, fuenteId, datosCubiertos, url, ts)
    } else if (formato === 'json') {
      return jsonARegistros(contenido, fuenteId, datosCubiertos, url, ts)
    } else {
      // Formato desconocido — probar JSON, luego CSV, luego texto
      try {
        return jsonARegistros(contenido, fuenteId, datosCubiertos, url, ts)
      } catch {
        try {
          return csvARegistros(contenido, fuenteId, datosCubiertos, url, ts)
        } catch {
          const texto = new TextDecoder('utf-8', { fatal: false }).decode(contenido).slice(0, 10_000)
          return [
            {
              contenido: texto,
              fuente: fuenteId,
              metodoAcceso: 'dataset_abierto',
              datosCubiertos: [...datosCubiertos],
              metadatos: { url, formato: 'desconocido' },
              obtenidoEn: ts,
            },
          ]
        }
      }
    }
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function descargar(url: string): Promise<{ contenido: Uint8Array; contentType: string }> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/csv,*/*',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} al descargar dataset: ${url}`)
  }

  const contentType = resp.headers.get('content-type') ?? ''
  const buffer = await resp.arrayBuffer()
  const contenido = new Uint8Array(buffer.slice(0, MAX_BYTES))
  return { contenido, contentType }
}

function detectarFormato(url: string, contentType: string): string {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('csv') || ct.includes('text/plain')) return 'csv'

  const urlBase = url.toLowerCase().split('?')[0]
  if (urlBase.endsWith('.json')) return 'json'
  if (urlBase.endsWith('.csv') || urlBase.endsWith('.tsv')) return 'csv'

  return 'desconocido'
}

function csvARegistros(
  contenido: Uint8Array,
  fuenteId: string,
  datosCubiertos: string[],
  url: string,
  ts: string,
): Omit<Registro, 'registroId'>[] {
  // Decodificar removiendo BOM si existe
  let texto = new TextDecoder('utf-8', { fatal: false }).decode(contenido)
  if (texto.startsWith('﻿')) texto = texto.slice(1)

  const lineas = texto.split('\n').filter(l => l.trim())
  if (lineas.length < 2) return []

  const cabeceras = lineas[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const registros: Omit<Registro, 'registroId'>[] = []

  for (let i = 1; i < lineas.length; i++) {
    const valores = lineas[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    const fila: Record<string, string> = {}
    for (let j = 0; j < cabeceras.length; j++) {
      fila[cabeceras[j]] = valores[j] ?? ''
    }
    registros.push({
      contenido: JSON.stringify(fila),
      fuente: fuenteId,
      metodoAcceso: 'dataset_abierto',
      datosCubiertos: [...datosCubiertos],
      metadatos: { url, formato: 'csv' },
      obtenidoEn: ts,
    })
  }

  return registros
}

function jsonARegistros(
  contenido: Uint8Array,
  fuenteId: string,
  datosCubiertos: string[],
  url: string,
  ts: string,
): Omit<Registro, 'registroId'>[] {
  const texto = new TextDecoder('utf-8').decode(contenido)
  const datos: unknown = JSON.parse(texto)
  const items = Array.isArray(datos) ? (datos as unknown[]) : [datos]

  return items.map(item => ({
    contenido: typeof item === 'string' ? item : JSON.stringify(item),
    fuente: fuenteId,
    metodoAcceso: 'dataset_abierto',
    datosCubiertos: [...datosCubiertos],
    metadatos: { url, formato: 'json' },
    obtenidoEn: ts,
  }))
}
