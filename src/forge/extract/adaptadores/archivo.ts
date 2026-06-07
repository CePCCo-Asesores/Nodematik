/**
 * Adaptador de extracción para archivos del cliente (metodo_acceso='archivo_cliente').
 * Traducción de src/forge/skills/forge-extract/scripts/adaptador_archivo.py a TypeScript.
 *
 * SEGURIDAD: confinamiento de ruta vía FORGE_UPLOAD_ROOT para prevenir path traversal.
 * El path del archivo debe declararse en fuente.metadatos.ruta.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Adaptador, FuentePlan, Registro } from '../types'
import { ahoraIso } from '../types'

const UPLOAD_ROOT = path.resolve(process.env['FORGE_UPLOAD_ROOT'] ?? '/tmp/forge-uploads')

// ─── Adaptador ────────────────────────────────────────────────────────────────

export const AdaptadorArchivo: Adaptador = {
  async obtener(fuente: FuentePlan, _credenciales: Record<string, unknown>): Promise<Omit<Registro, 'registroId'>[]> {
    const fuenteId = fuente.id
    const metadatos = (fuente.metadatos ?? {}) as Record<string, unknown>
    const rutaDeclarada = ((metadatos['ruta'] as string | undefined) ?? '').trim()

    if (!rutaDeclarada) {
      throw new Error(`fuente '${fuenteId}' tipo 'archivo_cliente' requiere metadatos.ruta.`)
    }

    const rutaSegura = resolverRutaSegura(rutaDeclarada, fuenteId)
    const datosCubiertos = fuente.datosQueCubre ?? []
    const ts = ahoraIso()
    const extension = path.extname(rutaSegura).toLowerCase()

    if (extension === '.csv') {
      return leerCsv(rutaSegura, fuenteId, datosCubiertos, ts, ',')
    } else if (extension === '.tsv') {
      return leerCsv(rutaSegura, fuenteId, datosCubiertos, ts, '\t')
    } else if (extension === '.json') {
      return leerJson(rutaSegura, fuenteId, datosCubiertos, ts)
    } else {
      return leerTexto(rutaSegura, fuenteId, datosCubiertos, ts)
    }
  },
}

// ─── Confinamiento de ruta ────────────────────────────────────────────────────

function resolverRutaSegura(rutaDeclarada: string, fuenteId: string): string {
  const candidata = path.resolve(UPLOAD_ROOT, rutaDeclarada)

  // Verificar que la ruta resuelta esté dentro del UPLOAD_ROOT
  if (!candidata.startsWith(UPLOAD_ROOT + path.sep) && candidata !== UPLOAD_ROOT) {
    throw new Error(
      `fuente '${fuenteId}': ruta '${rutaDeclarada}' intenta salir del directorio ` +
      `de uploads (${UPLOAD_ROOT}). Operación rechazada por seguridad.`
    )
  }

  if (!fs.existsSync(candidata)) {
    throw new Error(`fuente '${fuenteId}': archivo no encontrado en '${candidata}'.`)
  }

  const stat = fs.statSync(candidata)
  if (!stat.isFile()) {
    throw new Error(`fuente '${fuenteId}': la ruta '${candidata}' no es un archivo.`)
  }

  return candidata
}

// ─── Lectores de formato ──────────────────────────────────────────────────────

function leerCsv(
  ruta: string,
  fuenteId: string,
  datosCubiertos: string[],
  ts: string,
  delimitador: string,
): Omit<Registro, 'registroId'>[] {
  const contenido = fs.readFileSync(ruta, 'utf-8').replace(/^﻿/, '')
  const lineas = contenido.split('\n').filter(l => l.trim())
  if (lineas.length < 2) return []

  const cabeceras = parsearLineaCsv(lineas[0], delimitador)
  const registros: Omit<Registro, 'registroId'>[] = []

  for (let i = 1; i < lineas.length; i++) {
    const valores = parsearLineaCsv(lineas[i], delimitador)
    const fila: Record<string, string> = {}
    for (let j = 0; j < cabeceras.length; j++) {
      fila[cabeceras[j]] = valores[j] ?? ''
    }
    registros.push({
      contenido: JSON.stringify(fila),
      fuente: fuenteId,
      metodoAcceso: 'archivo_cliente',
      datosCubiertos: [...datosCubiertos],
      metadatos: { ruta, tipo: 'csv' },
      obtenidoEn: ts,
    })
  }

  return registros
}

function parsearLineaCsv(linea: string, delimitador: string): string[] {
  const resultado: string[] = []
  let actual = ''
  let enComillas = false

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (c === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"'
        i++
      } else {
        enComillas = !enComillas
      }
    } else if (c === delimitador && !enComillas) {
      resultado.push(actual.trim())
      actual = ''
    } else {
      actual += c
    }
  }
  resultado.push(actual.trim())
  return resultado
}

function leerJson(
  ruta: string,
  fuenteId: string,
  datosCubiertos: string[],
  ts: string,
): Omit<Registro, 'registroId'>[] {
  const contenido = fs.readFileSync(ruta, 'utf-8')
  const datos: unknown = JSON.parse(contenido)
  const items = Array.isArray(datos) ? (datos as unknown[]) : [datos]

  return items.map(item => ({
    contenido: typeof item === 'string' ? item : JSON.stringify(item),
    fuente: fuenteId,
    metodoAcceso: 'archivo_cliente',
    datosCubiertos: [...datosCubiertos],
    metadatos: { ruta, tipo: 'json' },
    obtenidoEn: ts,
  }))
}

function leerTexto(
  ruta: string,
  fuenteId: string,
  datosCubiertos: string[],
  ts: string,
): Omit<Registro, 'registroId'>[] {
  const contenido = fs.readFileSync(ruta, 'utf-8')
  if (!contenido.trim()) return []

  return [
    {
      contenido: contenido.slice(0, 50_000),
      fuente: fuenteId,
      metodoAcceso: 'archivo_cliente',
      datosCubiertos: [...datosCubiertos],
      metadatos: { ruta, tipo: 'texto' },
      obtenidoEn: ts,
    },
  ]
}
