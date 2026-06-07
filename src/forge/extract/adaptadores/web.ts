/**
 * Adaptador de extracción para scraping web (metodo_acceso='web').
 * Traducción de src/forge/skills/forge-extract/scripts/adaptador_web.py a TypeScript.
 *
 * INVARIANTE: siempre verifica robots.txt antes de hacer fetch.
 * Si robots.txt bloquea el user-agent, devuelve lista vacía (no lanza excepción).
 * Solo fetcha la página declarada — sin crawling ni seguimiento de links.
 */

import type { Adaptador, FuentePlan, Registro } from '../types'
import { ahoraIso } from '../types'

const USER_AGENT = 'ForgeExtract/1.0 (+https://nodematik.app)'

// ─── Adaptador ────────────────────────────────────────────────────────────────

export const AdaptadorWeb: Adaptador = {
  async obtener(fuente: FuentePlan, _credenciales: Record<string, unknown>): Promise<Omit<Registro, 'registroId'>[]> {
    const fuenteId = fuente.id
    const metadatos = (fuente.metadatos ?? {}) as Record<string, unknown>
    const url = ((metadatos['url'] as string | undefined) ?? '').trim()

    if (!url) {
      throw new Error(`fuente '${fuenteId}' tipo 'web' requiere metadatos.url.`)
    }

    if (!await robotsPermite(url)) {
      return []
    }

    const html = await fetchHtml(url)
    const texto = htmlATexto(html)

    if (!texto.trim()) return []

    const ts = ahoraIso()
    const datosCubiertos = fuente.datosQueCubre ?? []

    return [
      {
        contenido: texto.slice(0, 10_000),
        fuente: fuenteId,
        metodoAcceso: 'web',
        datosCubiertos: [...datosCubiertos],
        metadatos: { url },
        obtenidoEn: ts,
      },
    ]
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function robotsPermite(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`

    const resp = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5_000),
    })

    if (!resp.ok) {
      // Si no se puede leer robots.txt, ser conservador: no fetchar
      return false
    }

    const texto = await resp.text()
    return parsearRobots(texto, url)
  } catch {
    // Si no se puede leer robots.txt, ser conservador
    return false
  }
}

function parsearRobots(robotsTxt: string, url: string): boolean {
  const lineas = robotsTxt.split('\n').map(l => l.trim())
  let agentAplicable = false
  let disallow: string[] = []
  let allow: string[] = []

  for (const linea of lineas) {
    if (linea.toLowerCase().startsWith('user-agent:')) {
      const agente = linea.slice('user-agent:'.length).trim()
      agentAplicable = agente === '*' || agente.toLowerCase().includes('forgeextract')
      if (agentAplicable) {
        disallow = []
        allow = []
      }
    } else if (agentAplicable && linea.toLowerCase().startsWith('disallow:')) {
      const ruta = linea.slice('disallow:'.length).trim()
      if (ruta) disallow.push(ruta)
    } else if (agentAplicable && linea.toLowerCase().startsWith('allow:')) {
      const ruta = linea.slice('allow:'.length).trim()
      if (ruta) allow.push(ruta)
    }
  }

  const parsedUrl = new URL(url)
  const path = parsedUrl.pathname + parsedUrl.search

  // Allow más específico tiene precedencia sobre Disallow
  for (const ruta of allow) {
    if (path.startsWith(ruta)) return true
  }
  for (const ruta of disallow) {
    if (ruta === '/' || path.startsWith(ruta)) return false
  }

  return true
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} al fetchar página web: ${url}`)
  }
  return resp.text()
}

function htmlATexto(html: string): string {
  // Remover scripts y styles completos
  let texto = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  texto = texto.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  // Remover todos los tags HTML
  texto = texto.replace(/<[^>]+>/g, ' ')
  // Normalizar espacios
  texto = texto.replace(/\s+/g, ' ')
  // Decodificar entidades HTML básicas
  texto = texto.replace(/&amp;/g, '&')
  texto = texto.replace(/&lt;/g, '<')
  texto = texto.replace(/&gt;/g, '>')
  texto = texto.replace(/&quot;/g, '"')
  texto = texto.replace(/&#39;/g, "'")
  texto = texto.replace(/&nbsp;/g, ' ')
  return texto.trim()
}
