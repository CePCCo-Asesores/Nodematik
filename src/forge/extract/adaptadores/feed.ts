/**
 * Adaptador de extracción para fuentes RSS/Atom (metodo_acceso='feed').
 * Traducción de src/forge/skills/forge-extract/scripts/adaptador_feed.py a TypeScript.
 *
 * Lee el feed público, parsea las entradas y convierte cada una en un Registro.
 * No requiere credenciales — los feeds son públicos por definición.
 */

import type { Adaptador, FuentePlan, Registro } from '../types'
import { ahoraIso } from '../types'

const USER_AGENT = 'ForgeExtract/1.0 (+https://nodematik.app)'

const NS_ATOM = 'http://www.w3.org/2005/Atom'

interface EntradaFeed {
  titulo: string
  link: string
  contenido: string
  publicado: string
}

// ─── Adaptador ────────────────────────────────────────────────────────────────

export const AdaptadorFeed: Adaptador = {
  async obtener(fuente: FuentePlan, _credenciales: Record<string, unknown>): Promise<Omit<Registro, 'registroId'>[]> {
    const url = extraerUrl(fuente)
    const contenidoRaw = await fetchUrl(url)
    const entradas = parsearFeed(contenidoRaw, url)

    const fuenteId = fuente.id
    const datosCubiertos = fuente.datosQueCubre ?? []
    const ts = ahoraIso()

    return entradas.map(entrada => ({
      contenido: entrada.contenido,
      fuente: fuenteId,
      metodoAcceso: 'feed',
      datosCubiertos: [...datosCubiertos],
      metadatos: {
        url,
        titulo: entrada.titulo,
        link: entrada.link,
        publicado: entrada.publicado,
      },
      obtenidoEn: ts,
    }))
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extraerUrl(fuente: FuentePlan): string {
  const metadatos = (fuente.metadatos ?? {}) as Record<string, unknown>
  const url = (metadatos['url'] as string | undefined) ?? ''
  if (!url.trim()) {
    throw new Error(`fuente '${fuente.id}' tipo 'feed' requiere metadatos.url.`)
  }
  return url.trim()
}

async function fetchUrl(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} al fetchar feed: ${url}`)
  }
  return resp.text()
}

function parsearFeed(contenido: string, urlOrigen: string): EntradaFeed[] {
  // Parseo manual de RSS 2.0 y Atom 1.0 sin dependencias externas
  const entradas: EntradaFeed[] = []

  // RSS 2.0: buscar <item> elementos
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(contenido)) !== null) {
    const item = match[1]
    const entrada = parsearItemRss(item)
    if (entrada) entradas.push(entrada)
  }

  // Atom 1.0: buscar <entry> elementos
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi
  while ((match = entryRegex.exec(contenido)) !== null) {
    const entry = match[1]
    const entrada = parsearEntryAtom(entry)
    if (entrada) entradas.push(entrada)
  }

  return entradas
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = regex.exec(xml)
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1').trim() : ''
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i')
  const m = regex.exec(xml)
  return m ? m[1].trim() : ''
}

function parsearItemRss(item: string): EntradaFeed | null {
  const titulo = extractTag(item, 'title')
  const link = extractTag(item, 'link')
  const descripcion = extractTag(item, 'description')
  const publicado = extractTag(item, 'pubDate')
  const contenido = [titulo, descripcion].filter(Boolean).join('\n').trim()
  if (!contenido) return null
  return { titulo, link, contenido, publicado }
}

function parsearEntryAtom(entry: string): EntradaFeed | null {
  const titulo = extractTag(entry, 'title')
  const link = extractAttr(entry, 'link', 'href')
  const cuerpo = extractTag(entry, 'content') || extractTag(entry, 'summary')
  const publicado = extractTag(entry, 'published')
  const contenido = [titulo, cuerpo].filter(Boolean).join('\n').trim()
  if (!contenido) return null
  return { titulo, link, contenido, publicado }
}
