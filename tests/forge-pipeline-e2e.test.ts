/**
 * Test E2E del pipeline FORGE completo.
 *
 * Verifica que procesarSolicitud() ejecute los 6 pasos en orden y persista
 * el estado intermedio tras cada uno. Usa un adaptador fake de extracción
 * (registrado vía registrarAdaptador) y un LLM mockeado que devuelve JSON
 * válido para cada skill de la tubería.
 *
 * No requiere PostgreSQL ni Redis reales — mockeamos Prisma y la cola.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks hoisted ────────────────────────────────────────────────────────────

// Estado mutable que simula la tabla Solicitud en la BD.
const solicitudState: Record<string, unknown> = {}

vi.mock('../src/db', () => ({
  db: {
    solicitud: {
      create: vi.fn(async () => ({ id: 'sol-001' })),
      findUnique: vi.fn(async () => ({ ...solicitudState })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(solicitudState, data)
        return { ...solicitudState }
      }),
    },
    skill: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'skill-001', name: 'monitor-accesibilidad', version: 1 })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ forgeApproved: false })),
    },
    loopState: {
      create: vi.fn(async () => ({})),
    },
  },
}))

vi.mock('../src/crypto', () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
}))

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/queue/forge-scheduler', () => ({
  encolarSolicitud: vi.fn(),
  forgeQueue: { add: vi.fn() },
}))

// ─── Datos fake ───────────────────────────────────────────────────────────────

const fichaFake = {
  objetivo: 'Resumen de noticias sobre accesibilidad en México',
  datos_requeridos: ['noticias sobre accesibilidad'],
  fuentes_candidatas: [{ fuente: 'Google News RSS', acceso: 'obvio' }],
  eje_temporal: { tipo: 'unico' },
  entregable: 'resumen',
  pasos: [{ descripcion: 'extraer noticias', tipo: 'mecanico' }],
  tipo_de_accion: 'diagnostico',
  riesgo_operativo: { nivel: 'bajo', requiere_aprobacion: false, razon: 'datos públicos' },
  suficiencia: true,
  faltantes: [],
  skill_destino_sugerido: { nombre: null, razon: 'nuevo dominio', fallback: 'factory' },
}

// planFake: include both snake_case keys (for validarPlan which mirrors LLM snake_case output)
// and camelCase keys (for orquestador which uses the PlanExtraccion TS interface).
const planFake = {
  fuentes: [
    {
      id: 'src-1',
      fuente: 'Google News RSS',
      estado: 'disponible',
      // snake_case for validarPlan
      metodo_acceso: 'feed',
      datos_que_cubre: ['noticias sobre accesibilidad'],
      riesgo_fuente: 'bajo',
      razon: 'feed público',
      nota_permiso: 'RSS público',
      metadatos: { url: 'https://news.google.com/rss' },
      // camelCase for orquestador (PlanExtraccion / FuentePlan interface)
      metodoAcceso: 'feed' as const,
      datosQueCubre: ['noticias sobre accesibilidad'],
    },
  ],
  datos_requeridos: ['noticias sobre accesibilidad'],
  datosRequeridos: ['noticias sobre accesibilidad'],
  cobertura_datos: { completa: true, datos_sin_fuente: [], datos_condicionales: [] },
  resumen: { fuentes_disponibles: 1, fuentes_condicionales: 0, fuentes_descartadas: 0, fuentes_dudosas: 0 },
}

const encargoFake = {
  decision: 'fabricar',
  skill_objetivo: 'monitor-accesibilidad',
  justificacion: 'ningún skill existente cubre este dominio',
  especificacion_factory: {
    verbo_central: 'monitorear noticias de accesibilidad',
    señal_disparo: 'noticias de accesibilidad',
    formato_salida: 'resumen',
    complejidad: 'SKILL.md',
    distincion: 'específico de accesibilidad',
  },
  evidencia_usada: [{ registro_id: 'src-1:r0', fuente: 'src-1', razon: 'muestra tipo de noticia' }],
  nivel_generalizacion: 'vertical',
  basado_en_datos_completos: true,
  datos_faltantes: [],
  riesgo_acumulado: { nivel: 'bajo', fuentes_del_riesgo: [] },
  reaprobacion_requerida: true,
  requiere_revision_humana: false,
}

// ─── LLM mock — responde por orden de llamada ─────────────────────────────────

const mockLLMComplete = vi.fn()

vi.mock('../src/providers/llm', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/llm')>()
  return { ...original, getLLMProvider: vi.fn(() => ({ complete: mockLLMComplete })) }
})

function resetLLMResponses(fichaOverride?: Record<string, unknown>) {
  mockLLMComplete
    .mockResolvedValueOnce({ text: JSON.stringify(fichaOverride ?? fichaFake), inputTokens: 10, outputTokens: 10 })
    .mockResolvedValueOnce({ text: JSON.stringify(planFake), inputTokens: 10, outputTokens: 10 })
    .mockResolvedValueOnce({ text: JSON.stringify(encargoFake), inputTokens: 10, outputTokens: 10 })
    .mockResolvedValueOnce({ text: '# SKILL.md generado por factory', inputTokens: 10, outputTokens: 10 })
}

// ─── Adaptador fake ───────────────────────────────────────────────────────────

import { registrarAdaptador } from '../src/forge/extract/orquestador'
import type { Adaptador } from '../src/forge/extract/types'

const adaptadorFake: Adaptador = {
  async obtener(fuente) {
    return [
      {
        contenido: 'Noticia: avances en accesibilidad en México',
        fuente: fuente.id,
        metodoAcceso: 'feed' as const,
        datosCubiertos: fuente.datosQueCubre ?? [],
        metadatos: { url: 'https://example.com/noticia-1' },
        obtenidoEn: new Date().toISOString(),
      },
    ]
  },
}
registrarAdaptador('feed', adaptadorFake)

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pipeline FORGE completo — solicitud única', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Drain any leftover mockResolvedValueOnce queue from a previous test.
    // vi.clearAllMocks() only resets call history, not the response queue.
    mockLLMComplete.mockReset()
    // Reiniciar estado de la "BD"
    Object.keys(solicitudState).forEach(k => delete solicitudState[k])
    Object.assign(solicitudState, {
      id: 'sol-001',
      orgId: 'org-001',
      botId: 'bot-001',
      problema: 'Quiero un resumen de noticias sobre accesibilidad en México',
      estado: 'pendiente',
      bot: {
        llmProvider: 'anthropic',
        llmModel: 'claude-haiku-4-5-20251001',
        llmApiKeyEnc: 'enc-api-key',
      },
    })
    resetLLMResponses()
  })

  it('completa los 6 pasos y persiste estado en cada etapa', async () => {
    const { procesarSolicitud } = await import('../src/services/operador.service')

    await procesarSolicitud('sol-001')

    // Estado final
    expect(solicitudState['estado']).toBe('completado')

    // Cada etapa persistida
    expect(solicitudState['fichaJson']).toBeDefined()
    expect(solicitudState['planJson']).toBeDefined()
    expect(solicitudState['extraccionJson']).toBeDefined()
    expect(solicitudState['encargoJson']).toBeDefined()
    expect(solicitudState['skillId']).toBe('skill-001')

    // Sin loop para solicitud única
    const { db } = await import('../src/db')
    expect(db.loopState.create).not.toHaveBeenCalled()
  })

  it('invoca el LLM exactamente 4 veces (intake, sources, analyze, factory)', async () => {
    const { procesarSolicitud } = await import('../src/services/operador.service')

    await procesarSolicitud('sol-001')

    expect(mockLLMComplete).toHaveBeenCalledTimes(4)
  })

  it('la extracción es mecánica — usa adaptador, no LLM', async () => {
    const { procesarSolicitud } = await import('../src/services/operador.service')

    await procesarSolicitud('sol-001')

    // LLM solo en los 4 pasos con-juicio, no en extracción
    expect(mockLLMComplete).toHaveBeenCalledTimes(4)

    const extraccion = solicitudState['extraccionJson'] as Record<string, unknown>
    const registros = extraccion?.['registros'] as unknown[] | undefined
    expect(registros?.length).toBeGreaterThan(0)
  })

  it('el skill fabricado nace con forgeApproved:false (gate)', async () => {
    const { procesarSolicitud } = await import('../src/services/operador.service')
    const { db } = await import('../src/db')

    await procesarSolicitud('sol-001')

    const [[createCall]] = db.skill.create.mock.calls as Array<[{ data: Record<string, unknown> }]>
    expect(createCall.data.forgeApproved).toBe(false)
    expect(createCall.data.requiereRevisionHumana).toBe(true)
  })

  it('marca error si el LLM devuelve JSON inválido en intake', async () => {
    mockLLMComplete.mockReset()
    mockLLMComplete.mockResolvedValueOnce({ text: 'esto no es json', inputTokens: 10, outputTokens: 10 })

    const { procesarSolicitud } = await import('../src/services/operador.service')

    await procesarSolicitud('sol-001')

    expect(solicitudState['estado']).toBe('error')
    expect(typeof solicitudState['errorDetalle']).toBe('string')
  })

  it('la versión real del skill llega a skillOperante del loop (fix P0 versión)', async () => {
    // Solicitud continua
    const fichaFakeContinua = { ...fichaFake, eje_temporal: { tipo: 'continuo', ritmo: 'diario' } }
    mockLLMComplete.mockReset()
    resetLLMResponses(fichaFakeContinua)

    const { db } = await import('../src/db')
    db.skill.create.mockResolvedValueOnce({ id: 'skill-001', name: 'monitor-accesibilidad', version: 3 })

    const { procesarSolicitud } = await import('../src/services/operador.service')
    await procesarSolicitud('sol-001')

    const [[loopCall]] = db.loopState.create.mock.calls as Array<[{ data: Record<string, unknown> }]>
    const skillOperante = loopCall?.data?.skillOperante as Record<string, unknown>
    expect(skillOperante?.['version']).toBe(3)
  })
})
