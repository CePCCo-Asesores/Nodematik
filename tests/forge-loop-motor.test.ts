/**
 * Tests del motor del lazo continuo (forge-loop).
 *
 * El motor es la pieza más delicada del operador: corre sin supervisión, decide
 * cuándo adaptar, y tiene frenos contra hiperactividad. Estos tests verifican su
 * comportamiento contra un AlmacenEstado en memoria que implementa la interfaz real.
 *
 * Se prueban: operación normal, guard de estado no-activo, pausa por fallos,
 * extracción vacía según política, detección de deterioro→adaptación, y los frenos
 * (cooldown y techo de adaptaciones).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ejecutarRafaga,
  configurarTuberia,
  MAX_FALLOS_CONSECUTIVOS,
} from '../src/forge/loop/motor'
import type { AlmacenEstado, EstadoLazo } from '../src/forge/loop/types'

// ─── Almacén en memoria que implementa la interfaz real ───────────────────────

class AlmacenMemoria implements AlmacenEstado {
  private datos = new Map<string, EstadoLazo>()

  sembrar(estado: EstadoLazo): void {
    this.datos.set(estado.loopId, estado)
  }

  obtener(loopId: string): EstadoLazo | undefined {
    return this.datos.get(loopId)
  }

  async cargarConLock(loopId: string): Promise<EstadoLazo | null> {
    const e = this.datos.get(loopId)
    return e ? structuredClone(e) : null
  }

  async guardarYLiberar(estado: EstadoLazo): Promise<void> {
    this.datos.set(estado.loopId, estado)
  }

  async listarPendientes(): Promise<string[]> {
    const ahora = new Date()
    return [...this.datos.values()]
      .filter(e => e.estadoOperativo === 'activo' && e.proximaEjecucion !== null && e.proximaEjecucion <= ahora)
      .map(e => e.loopId)
  }
}

function estadoBase(overrides: Partial<EstadoLazo> = {}): EstadoLazo {
  return {
    loopId: 'loop-1',
    fichaId: 'ficha-1',
    orgId: 'org-1',
    ritmo: { tipo: 'cron', valor: 'diario' } as EstadoLazo['ritmo'],
    estadoOperativo: 'activo',
    ultimaEjecucion: null,
    proximaEjecucion: null,
    ejecucionesTotales: 0,
    huellaAnterior: null,
    skillOperante: { name: 'monitor-x', version: '1.0', approvedAt: '2026-06-06T00:00:00Z' },
    fallosConsecutivos: 0,
    ultimaAnomalia: null,
    pendienteAprobacion: false,
    politicaAdaptacion: {
      adaptarSi: ['fuente_muerta'],
      noAdaptarSi: ['cambio_normal'],
      maxAdaptacionesPorPeriodo: 3,
      periodoHoras: 24,
      extraccionVaciaEsFallo: true,
    } as EstadoLazo['politicaAdaptacion'],
    cooldownAdaptacionHasta: null,
    adaptacionesEnPeriodo: { conteo: 0, ventanaInicio: new Date().toISOString() } as EstadoLazo['adaptacionesEnPeriodo'],
    historial: [],
    ...overrides,
  }
}

// Resultados de tubería simulados
const tuberiaConDatos = async () => ({
  registros: [{ registro_id: 'r1', contenido: 'noticia A' }],
  resumen_extraccion: { extraccion_completa: true, datos_sin_extraer: [], fuentes_ok: 1 },
})
const tuberiaVacia = async () => ({
  registros: [],
  resumen_extraccion: { extraccion_completa: true, datos_sin_extraer: [], fuentes_ok: 1 },
})
const tuberiaQueFalla = async () => { throw new Error('fuente no responde') }

describe('motor del lazo — ejecutarRafaga', () => {
  let almacen: AlmacenMemoria

  beforeEach(() => {
    almacen = new AlmacenMemoria()
  })

  it('omite la ráfaga si el lazo no está activo', async () => {
    configurarTuberia(tuberiaConDatos)
    almacen.sembrar(estadoBase({ estadoOperativo: 'pausado' }))
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(r.ejecutado).toBe(false)
    expect(r.evento).toBe('omitido')
    // No corrió la tubería: ejecucionesTotales sigue en 0
    expect(almacen.obtener('loop-1')!.ejecucionesTotales).toBe(0)
  })

  it('omite la ráfaga si hay aprobación pendiente', async () => {
    configurarTuberia(tuberiaConDatos)
    almacen.sembrar(estadoBase({ pendienteAprobacion: true }))
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(r.ejecutado).toBe(false)
    expect(r.evento).toBe('omitido')
  })

  it('opera normal con datos y registra la ejecución', async () => {
    configurarTuberia(tuberiaConDatos)
    almacen.sembrar(estadoBase())
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(r.ejecutado).toBe(true)
    expect(r.evento).toBe('ejecucion_ok')
    const e = almacen.obtener('loop-1')!
    expect(e.ejecucionesTotales).toBe(1)
    expect(e.huellaAnterior).not.toBeNull()
    expect(e.fallosConsecutivos).toBe(0)
  })

  it('cuenta extracción vacía como fallo cuando la política lo dice', async () => {
    configurarTuberia(tuberiaVacia)
    almacen.sembrar(estadoBase())
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(almacen.obtener('loop-1')!.fallosConsecutivos).toBe(1)
    expect(r.evento).not.toBe('ejecucion_ok')
  })

  it('trata extracción vacía como ok cuando es monitoreo de ausencia', async () => {
    configurarTuberia(tuberiaVacia)
    almacen.sembrar(estadoBase({
      politicaAdaptacion: {
        adaptarSi: [], noAdaptarSi: [], maxAdaptacionesPorPeriodo: 3,
        periodoHoras: 24, extraccionVaciaEsFallo: false,
      } as EstadoLazo['politicaAdaptacion'],
    }))
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(r.evento).toBe('extraccion_vacia_ok')
    expect(almacen.obtener('loop-1')!.fallosConsecutivos).toBe(0)
  })

  it('una excepción de la tubería incrementa fallos', async () => {
    configurarTuberia(tuberiaQueFalla)
    almacen.sembrar(estadoBase())
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(r.evento).toBe('fallo')
    expect(almacen.obtener('loop-1')!.fallosConsecutivos).toBe(1)
  })

  it('pausa el lazo tras MAX_FALLOS_CONSECUTIVOS fallos', async () => {
    configurarTuberia(tuberiaQueFalla)
    almacen.sembrar(estadoBase({ fallosConsecutivos: MAX_FALLOS_CONSECUTIVOS - 1 }))
    const r = await ejecutarRafaga('loop-1', almacen)
    expect(r.evento).toBe('pausa_por_fallos')
    expect(almacen.obtener('loop-1')!.estadoOperativo).toBe('pausado')
  })

  it('inicia adaptación cuando detecta deterioro (mueren las fuentes)', async () => {
    // NOTA DE AUDITORÍA: el TS detecta deterioro por la huella real — caída de
    // 'cobertura_pct' >30 puntos, todas las fuentes muertas, o >50% de fuentes perdidas
    // (campo 'fuente' de cada registro). Difiere del diseño Python que miraba
    // extraccion_completa/datos_sin_extraer.
    // Primera ráfaga: dos fuentes activas, cobertura alta.
    const tuberiaSana = async () => ({
      registros: [
        { registro_id: 'r1', contenido: 'A', fuente: 'feed-1' },
        { registro_id: 'r2', contenido: 'B', fuente: 'feed-2' },
      ],
      cobertura_pct: 100,
    })
    // Segunda: todas las fuentes desaparecen (registros sin fuente) → deterioro.
    const tuberiaMuerta = async () => ({
      registros: [{ registro_id: 'r3', contenido: 'C', fuente: '' }],
      cobertura_pct: 100,
    })
    almacen.sembrar(estadoBase())

    configurarTuberia(tuberiaSana)
    await ejecutarRafaga('loop-1', almacen)

    configurarTuberia(tuberiaMuerta)
    const r = await ejecutarRafaga('loop-1', almacen)

    expect(r.evento).toBe('adaptacion_iniciada')
    const e = almacen.obtener('loop-1')!
    expect(e.estadoOperativo).toBe('adaptando')
    expect(e.pendienteAprobacion).toBe(true)        // cruza el gate
    expect(e.cooldownAdaptacionHasta).not.toBeNull() // activa el cooldown
  })
})
