/**
 * Adaptador de extracción para APIs REST/JSON (metodo_acceso='api').
 * Traducción de src/forge/skills/forge-extract/scripts/adaptador_api.py a TypeScript.
 *
 * Llama el endpoint declarado en fuente.metadatos, parsea la respuesta JSON
 * y convierte cada elemento en un Registro.
 * Soporta autenticación por header (Bearer, API key) declarada en credenciales.
 */

import type { Adaptador, FuentePlan, Registro } from '../types'
import { ahoraIso } from '../types'

const USER_AGENT = 'ForgeExtract/1.0 (+https://nodematik.app)'

// ─── Adaptador ────────────────────────────────────────────────────────────────

export const AdaptadorApi: Adaptador = {
  async obtener(fuente: FuentePlan, credenciales: Record<string, unknown>): Promise<Omit<Registro, 'registroId'>[]> {
    const fuenteId = fuente.id
    const metadatos = (fuente.metadatos ?? {}) as Record<string, unknown>
    let endpoint = ((metadatos['endpoint'] ?? metadatos['url']) as string | undefined) ?? ''

    if (!endpoint.trim()) {
      throw new Error(`fuente '${fuenteId}' tipo 'api' requiere metadatos.endpoint.`)
    }

    const credsFuente = (credenciales[fuenteId] as Record<string, unknown> | undefined) ?? {}
    const headers = construirHeaders(credsFuente)

    const params = metadatos['params'] as Record<string, string> | undefined
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString()
      endpoint = endpoint.includes('?') ? `${endpoint}&${qs}` : `${endpoint}?${qs}`
    }

    const datosJson = await fetchJson(endpoint, headers)
    return jsonARegistros(datosJson, fuente, fuenteId, metadatos)
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function construirHeaders(creds: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': USER_AGENT,
  }

  const token = (creds['bearer_token'] ?? creds['access_token']) as string | undefined
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
    return headers
  }

  const apiKey = creds['api_key'] as string | undefined
  if (apiKey) {
    const keyHeader = (creds['api_key_header'] as string | undefined) ?? 'X-API-Key'
    headers[keyHeader] = apiKey
  }

  return headers
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const resp = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} al llamar API: ${url}`)
  }
  return resp.json()
}

function jsonARegistros(
  datos: unknown,
  fuente: FuentePlan,
  fuenteId: string,
  metadatos: Record<string, unknown>,
): Omit<Registro, 'registroId'>[] {
  const datosCubiertos = fuente.datosQueCubre ?? []
  const ts = ahoraIso()

  const hacerRegistro = (item: unknown): Omit<Registro, 'registroId'> => ({
    contenido: typeof item === 'string' ? item : JSON.stringify(item),
    fuente: fuenteId,
    metodoAcceso: 'api',
    datosCubiertos: [...datosCubiertos],
    metadatos: {
      endpoint: metadatos['endpoint'] ?? '',
      obtenido_en_raw: ts,
    },
    obtenidoEn: ts,
  })

  if (Array.isArray(datos)) {
    return (datos as unknown[]).filter(item => item !== null && item !== undefined).map(hacerRegistro)
  }

  if (datos && typeof datos === 'object') {
    const claveListaDeclarada = metadatos['response_list_key'] as string | undefined
    if (claveListaDeclarada) {
      const listaValor = (datos as Record<string, unknown>)[claveListaDeclarada]
      if (Array.isArray(listaValor)) {
        return (listaValor as unknown[]).filter(item => item !== null && item !== undefined).map(hacerRegistro)
      }
    }
    return [hacerRegistro(datos)]
  }

  if (typeof datos === 'string' && (datos as string).trim()) {
    return [hacerRegistro(datos)]
  }

  return []
}
