/**
 * Tipos compartidos para forge-extract.
 * Traducción de src/forge/skills/forge-extract/scripts/contrato.py a TypeScript.
 *
 * Invariante del registro_id: "src-N:rM"
 *   N = índice base-1 de la fuente en el plan
 *   M = contador base-0 de registro dentro de esa fuente
 *   El orquestador sella el registro_id — los adaptadores NO lo asignan.
 */

// ─── Tipos de valor ───────────────────────────────────────────────────────────

export type MetodoAcceso =
  | 'api'
  | 'feed'
  | 'web'
  | 'archivo_cliente'
  | 'dataset_abierto'

export type EstadoFuente = 'disponible' | 'condicional' | 'descartada' | 'dudosa'

// ─── Registro ─────────────────────────────────────────────────────────────────

export interface Registro {
  contenido: string           // texto extraído de la fuente
  fuente: string              // id de la fuente en el plan (estable, único)
  metodoAcceso: MetodoAcceso
  registroId: string          // sellado por el orquestador: "src-N:rM"
  datosCubiertos: string[]    // subset de datos_requeridos que este registro aporta
  metadatos: Record<string, unknown>  // url/path/timestamp específicos del adaptador
  obtenidoEn: string          // ISO 8601 UTC
}

// ─── ResultadoExtraccion ──────────────────────────────────────────────────────

export interface ResultadoExtraccion {
  registros: Registro[]
  fuentesUsadas: string[]     // ids de fuentes de las que se obtuvo al menos un registro
  fuentesOmitidas: string[]   // ids de fuentes omitidas
  coberturaPct: number        // calculada honestamente (0–100)
  datosCubiertos: string[]    // intersection(datosCubiertos, datosRequeridos)
  datosFaltantes: string[]    // datosRequeridos sin cobertura
  requiereRevisionHumana: boolean  // propagado desde el plan
  extraidoEn: string          // ISO 8601 UTC
}

// ─── FuentePlan ──────────────────────────────────────────────────────────────

export interface FuentePlan {
  id: string
  estado: EstadoFuente
  metodoAcceso: MetodoAcceso | null
  datosQueCubre: string[]
  requiereDelCliente?: string
  metadatos: Record<string, unknown>
  riesgoFuente?: string
  notaPermiso?: string
}

// ─── Plan (output de forge-sources) ──────────────────────────────────────────

export interface PlanExtraccion {
  fuentes: FuentePlan[]
  datosRequeridos: string[]
  coberturaPct?: number
  requiereRevisionHumana?: boolean
}

// ─── Adaptador ────────────────────────────────────────────────────────────────

export interface Adaptador {
  /**
   * Extrae registros de la fuente usando las credenciales proporcionadas.
   * Los Registros que devuelve NO tienen registroId asignado —
   * el orquestador los sella con sellarRegistroId() después.
   *
   * Lista vacía = sin datos disponibles en este momento (no es un error).
   * Excepción = error irrecuperable (el orquestador la captura y omite la fuente).
   */
  obtener(fuente: FuentePlan, credenciales: Record<string, unknown>): Promise<Omit<Registro, 'registroId'>[]>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function ahoraIso(): string {
  return new Date().toISOString()
}

export function sellarRegistroId(registro: Omit<Registro, 'registroId'>, srcIdx: number, rIdx: number): Registro {
  return { ...registro, registroId: `src-${srcIdx}:r${rIdx}` }
}

// ─── Resultados de validación (compartido por todos los validadores) ──────────

export interface ResultadoValidacion {
  valida: boolean
  errores: string[]
  advertencias: string[]
  requiereRevisionHumana: boolean
}
