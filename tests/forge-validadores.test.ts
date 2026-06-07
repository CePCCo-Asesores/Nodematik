/**
 * Tests de los validadores deterministas del operador FORGE.
 * Cubren forge-intake (ficha), forge-sources (plan) y forge-analyze (encargo).
 *
 * Estrategia: cada validador es una función pura sin efectos. Probamos el caso
 * válido (pasa), y cada regla de rechazo (falla con el error esperado). Esto
 * protege contra regresiones al traducir o refactorizar la lógica.
 */

import { describe, it, expect } from 'vitest'
import { validarFicha } from '../src/forge/intake/validar-ficha'
import { validarPlan } from '../src/forge/sources/validar-plan'
import { validarEncargo } from '../src/forge/analyze/validar-encargo'

// ─── Helpers: constructores de objetos válidos base ───────────────────────────

function fichaValida(overrides: Record<string, unknown> = {}) {
  return {
    objetivo: 'Monitorear noticias sobre neurodivergencia en México',
    datos_requeridos: ['noticias recientes'],
    fuentes_candidatas: [{ fuente: 'Google News RSS', acceso: 'obvio' }],
    eje_temporal: { tipo: 'continuo', ritmo: 'diario' },
    entregable: 'alertas de noticias relevantes',
    pasos: [{ descripcion: 'extraer noticias', tipo: 'mecanico' }],
    tipo_de_accion: 'monitoreo',
    riesgo_operativo: { nivel: 'bajo', requiere_aprobacion: false, razon: 'datos públicos' },
    suficiencia: true,
    faltantes: [],
    skill_destino_sugerido: { nombre: 'monitor-noticias', razon: 'monitoreo continuo', fallback: 'factory' },
    ...overrides,
  }
}

// ─── forge-intake: validarFicha ───────────────────────────────────────────────

describe('validarFicha', () => {
  it('acepta una ficha completa y bien formada', () => {
    const r = validarFicha(fichaValida())
    expect(r.valida).toBe(true)
    expect(r.errores).toHaveLength(0)
  })

  it('rechaza un tipo primitivo en vez de objeto', () => {
    expect(validarFicha('no soy objeto').valida).toBe(false)
    expect(validarFicha(null).valida).toBe(false)
    expect(validarFicha([1, 2]).valida).toBe(false)
  })

  it('marca requiereRevisionHumana cuando hay errores', () => {
    const r = validarFicha({})
    expect(r.valida).toBe(false)
    expect(r.requiereRevisionHumana).toBe(true)
  })

  it('reporta cada campo requerido ausente', () => {
    const r = validarFicha({ objetivo: 'algo' })
    expect(r.errores.some(e => e.includes('datos_requeridos'))).toBe(true)
    expect(r.errores.some(e => e.includes('eje_temporal'))).toBe(true)
  })

  it('exige ritmo cuando eje_temporal.tipo es continuo', () => {
    const r = validarFicha(fichaValida({ eje_temporal: { tipo: 'continuo' } }))
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('ritmo'))).toBe(true)
  })

  it('acepta eje_temporal unico sin ritmo', () => {
    const r = validarFicha(fichaValida({ eje_temporal: { tipo: 'unico' } }))
    expect(r.valida).toBe(true)
  })

  it('rechaza tipo_de_accion inválido', () => {
    const r = validarFicha(fichaValida({ tipo_de_accion: 'inventado' }))
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('tipo_de_accion'))).toBe(true)
  })

  it('rechaza paso con tipo distinto de mecanico/con-juicio', () => {
    const r = validarFicha(fichaValida({ pasos: [{ descripcion: 'x', tipo: 'magico' }] }))
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('pasos[0].tipo'))).toBe(true)
  })

  it('rechaza nivel de riesgo inválido', () => {
    const r = validarFicha(fichaValida({
      riesgo_operativo: { nivel: 'extremo', requiere_aprobacion: true, razon: 'x' },
    }))
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('riesgo_operativo.nivel'))).toBe(true)
  })

  it('exige faltantes cuando suficiencia es false', () => {
    const r = validarFicha(fichaValida({ suficiencia: false, faltantes: [] }))
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('faltantes'))).toBe(true)
  })

  it('eleva revisión humana cuando el riesgo es alto', () => {
    const r = validarFicha(fichaValida({
      riesgo_operativo: { nivel: 'alto', requiere_aprobacion: true, razon: 'datos sensibles' },
    }))
    expect(r.valida).toBe(true)
    expect(r.requiereRevisionHumana).toBe(true)
  })

  it('eleva revisión humana cuando tipo_de_accion es ejecucion', () => {
    const r = validarFicha(fichaValida({ tipo_de_accion: 'ejecucion' }))
    expect(r.requiereRevisionHumana).toBe(true)
  })

  it('eleva revisión humana en monitoreo continuo de riesgo medio', () => {
    const r = validarFicha(fichaValida({
      eje_temporal: { tipo: 'continuo', ritmo: 'diario' },
      riesgo_operativo: { nivel: 'medio', requiere_aprobacion: false, razon: 'x' },
    }))
    expect(r.requiereRevisionHumana).toBe(true)
  })
})

// ─── forge-sources: validarPlan ───────────────────────────────────────────────

function planValido(overrides: Record<string, unknown> = {}) {
  return {
    fuentes: [
      {
        id: 'src-1',
        fuente: 'Google News RSS',
        estado: 'disponible',
        metodo_acceso: 'feed',
        datos_que_cubre: ['noticias recientes'],
        requiere_del_cliente: null,
        riesgo_fuente: 'bajo',
        razon: 'feed público',
        nota_permiso: 'RSS público permitido',
        metadatos: { url: 'https://news.google.com/rss' },
      },
    ],
    resumen: { fuentes_disponibles: 1, fuentes_condicionales: 0, fuentes_descartadas: 0, fuentes_dudosas: 0 },
    cobertura_datos: { completa: true, datos_sin_fuente: [], datos_condicionales: [] },
    ...overrides,
  }
}

describe('validarPlan', () => {
  const datosRequeridos = ['noticias recientes']

  it('acepta un plan bien formado que cubre los datos requeridos', () => {
    const r = validarPlan(planValido(), datosRequeridos)
    expect(r.valida).toBe(true)
    expect(r.errores).toHaveLength(0)
  })

  it('rechaza un plan que no es objeto', () => {
    expect(validarPlan('x', datosRequeridos).valida).toBe(false)
    expect(validarPlan(null, datosRequeridos).valida).toBe(false)
  })

  it('rechaza una fuente sin id', () => {
    const plan = planValido()
    delete (plan.fuentes[0] as Record<string, unknown>).id
    const r = validarPlan(plan, datosRequeridos)
    expect(r.valida).toBe(false)
  })

  it('rechaza ids de fuente duplicados', () => {
    const plan = planValido({
      fuentes: [
        { ...planValido().fuentes[0], id: 'dup' },
        { ...planValido().fuentes[0], id: 'dup' },
      ],
    })
    const r = validarPlan(plan, datosRequeridos)
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.toLowerCase().includes('duplicad') || e.includes('dup'))).toBe(true)
  })

  it('rechaza fuente usable sin metadatos de acceso', () => {
    // Una fuente usable debe traer en metadatos el dato de acceso que su metodo necesita
    // (url para feed). Sin esto, el extractor no sabe de dónde extraer.
    const plan = planValido()
    ;(plan.fuentes[0] as Record<string, unknown>).metadatos = {}
    const r = validarPlan(plan, datosRequeridos)
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('metadatos.url'))).toBe(true)
  })

  it('rechaza estado de fuente inválido', () => {
    const plan = planValido()
    ;(plan.fuentes[0] as Record<string, unknown>).estado = 'quizas'
    const r = validarPlan(plan, datosRequeridos)
    expect(r.valida).toBe(false)
  })
})

// ─── forge-analyze: validarEncargo ────────────────────────────────────────────

function extraccionValida() {
  return {
    registros: [{ registro_id: 'src-1:r0', contenido: 'algo', fuente: 'Google News RSS' }],
    resumen_extraccion: { extraccion_completa: true, datos_sin_extraer: [], fuentes_ok: 1 },
  }
}

// NOTA DE AUDITORÍA: la versión TS de validarEncargo difiere del diseño Python original.
// En el TS, 'skill_objetivo' es el NOMBRE del skill a construir y SIEMPRE es requerido
// (string no vacío), incluso al fabricar — no null como en el diseño Python. Los tests
// se alinean al contrato real del TS, que es lo que va a producción.
function encargoFabricar(overrides: Record<string, unknown> = {}) {
  return {
    decision: 'fabricar',
    skill_objetivo: 'monitor-neurodivergencia',
    justificacion: 'ningún skill cubre el monitoreo de neurodivergencia en noticias',
    especificacion_factory: {
      verbo_central: 'monitorear noticias de neurodivergencia',
      señal_disparo: 'vigilar noticias sobre neurodivergencia',
      formato_salida: 'alerta',
      complejidad: 'SKILL.md + scripts',
      distincion: 'distinto de monitor de marca genérico',
    },
    evidencia_usada: [{ registro_id: 'src-1:r0', fuente: 'src-1', razon: 'muestra el tipo de noticia' }],
    nivel_generalizacion: 'vertical',
    basado_en_datos_completos: true,
    datos_faltantes: [],
    riesgo_acumulado: { nivel: 'bajo', fuentes_del_riesgo: [] },
    reaprobacion_requerida: true,
    requiere_revision_humana: false,
    ...overrides,
  }
}

describe('validarEncargo', () => {
  it('acepta un encargo de fabricar bien formado', () => {
    const r = validarEncargo(encargoFabricar(), extraccionValida())
    expect(r.valida).toBe(true)
    expect(r.errores).toHaveLength(0)
  })

  it('rechaza decision inválida', () => {
    const r = validarEncargo(encargoFabricar({ decision: 'clonar' }), extraccionValida())
    expect(r.valida).toBe(false)
  })

  it('exige skill_objetivo presente (nombre del skill a construir)', () => {
    const r = validarEncargo(encargoFabricar({ skill_objetivo: null }), extraccionValida())
    expect(r.valida).toBe(false)
    expect(r.errores.some(e => e.includes('skill_objetivo'))).toBe(true)
  })

  it('exige reaprobacion al fabricar (no aprobado por herencia)', () => {
    const r = validarEncargo(encargoFabricar({ reaprobacion_requerida: false }), extraccionValida())
    expect(r.valida).toBe(false)
  })

  it('exige revisión humana cuando nivel_generalizacion es universal', () => {
    const r = validarEncargo(
      encargoFabricar({ nivel_generalizacion: 'universal', requiere_revision_humana: false }),
      extraccionValida(),
    )
    expect(r.valida).toBe(false)
  })

  it('marca revisión humana (sin invalidar) cuando el riesgo acumulado es alto', () => {
    // El riesgo alto no invalida el encargo — lo marca para revisión humana. El gate
    // humano decide; el validador no bloquea, eleva la señal.
    const r = validarEncargo(
      encargoFabricar({
        riesgo_acumulado: { nivel: 'alto', fuentes_del_riesgo: ['datos sensibles'] },
        requiere_revision_humana: false,
      }),
      extraccionValida(),
    )
    expect(r.valida).toBe(true)
    expect(r.requiereRevisionHumana).toBe(true)
  })
})
