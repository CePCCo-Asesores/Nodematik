/**
 * Tipos para el estado del lazo continuo forge-loop.
 * Traducción de src/forge/skills/forge-loop/scripts/estado.py a TypeScript.
 *
 * El EstadoLazo mapea 1:1 al modelo Prisma LoopState.
 * Los campos Json de Prisma corresponden a los objetos anidados aquí.
 *
 * REQUISITO CRÍTICO: todo acceso de escritura al estado de un lazo activo
 * debe usar SELECT … FOR UPDATE SKIP LOCKED (ver AlmacenEstado.cargarConLock).
 */

// ─── Tipos de valor ───────────────────────────────────────────────────────────

export type EstadoOperativo = 'activo' | 'pausado' | 'adaptando' | 'detenido'
export type TipoRitmo = 'cron' | 'umbral'
export type OperadorUmbral = '>' | '<' | '>=' | '<=' | '=='

// ─── Ritmo ────────────────────────────────────────────────────────────────────

export interface RitmoCron {
  tipo: 'cron'
  valor: string    // expresión cron, ej: "0 9 * * 1" (lunes 9h)
}

export interface RitmoUmbral {
  tipo: 'umbral'
  metrica: string
  operador: OperadorUmbral
  valorUmbral: number
}

export type Ritmo = RitmoCron | RitmoUmbral

// ─── SkillOperante ────────────────────────────────────────────────────────────

export interface SkillOperante {
  name: string        // kebab-case del skill
  version: number
  approvedAt: string  // ISO 8601
}

// ─── PoliticaAdaptacion ──────────────────────────────────────────────────────

export interface PoliticaAdaptacion {
  adaptarSi: string
  noAdaptarSi: string
  maxAdaptacionesPorPeriodo: number  // default 3
  periodoHoras: number               // default 24
  extraccionVaciaEsFallo: boolean    // default true
}

// ─── Huella ───────────────────────────────────────────────────────────────────

export interface Huella {
  contenidoHash: string     // sha256 truncado del contenido de los registros
  coberturaPct: number
  fuentesActivas: string[]  // ids de fuentes que aportaron registros
}

// ─── EntradaHistorial ─────────────────────────────────────────────────────────

export type EventoLazo =
  | 'ejecucion_ok'
  | 'fallo'
  | 'extraccion_vacia'
  | 'extraccion_vacia_ok'
  | 'adaptacion_iniciada'
  | 'adaptacion_frenada_cooldown'
  | 'pausa_por_fallos'
  | 'pausa_por_adaptaciones'

export interface EntradaHistorial {
  ts: string          // ISO 8601
  evento: EventoLazo | string
  detalle: string
}

// ─── AdaptacionesEnPeriodo ────────────────────────────────────────────────────

export interface AdaptacionesEnPeriodo {
  periodoInicio: string  // ISO 8601
  count: number
}

// ─── EstadoLazo (objeto principal) ───────────────────────────────────────────

export interface EstadoLazo {
  loopId: string
  fichaId: string
  orgId: string
  ritmo: Ritmo
  estadoOperativo: EstadoOperativo
  ultimaEjecucion: Date | null
  proximaEjecucion: Date | null
  ejecucionesTotales: number
  huellaAnterior: Huella | null
  skillOperante: SkillOperante
  fallosConsecutivos: number
  ultimaAnomalia: { tipo: string; detalle: string; ts: string } | null
  pendienteAprobacion: boolean
  politicaAdaptacion: PoliticaAdaptacion
  cooldownAdaptacionHasta: Date | null
  adaptacionesEnPeriodo: AdaptacionesEnPeriodo
  historial: EntradaHistorial[]
}

// ─── Interfaz del almacén ─────────────────────────────────────────────────────

export interface AlmacenEstado {
  /**
   * Carga el EstadoLazo con lock exclusivo usando SELECT … FOR UPDATE SKIP LOCKED.
   * Devuelve null si el registro está bloqueado por otra instancia o no existe.
   * La transacción permanece abierta hasta que se llame guardarYLiberar().
   */
  cargarConLock(loopId: string): Promise<EstadoLazo | null>

  /**
   * Persiste el estado actualizado y libera el lock.
   * Siempre llamar cuando cargarConLock() devolvió un estado, incluso si
   * no hubo cambios (para liberar el lock).
   */
  guardarYLiberar(estado: EstadoLazo): Promise<void>

  /**
   * Lista los loopIds de lazos activos cuya proximaEjecucion ya pasó.
   * SQL: WHERE estado_operativo='activo' AND proxima_ejecucion <= NOW()
   * Usa el índice compuesto (estado_operativo, proxima_ejecucion).
   */
  listarPendientes(): Promise<string[]>
}

// ─── Resultado de una ráfaga ──────────────────────────────────────────────────

export interface ResultadoRafaga {
  ejecutado: boolean
  evento: string
  detalle: string
}
