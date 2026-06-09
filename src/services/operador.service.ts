/**
 * Servicio Operador Autónomo FORGE (paso 8.5).
 *
 * Orquesta el pipeline completo:
 *   problema NL → forge-intake → forge-sources → forge-extract
 *                → forge-analyze → [factory] → [forge-loop]
 *
 * Cada paso persiste su resultado en la Solicitud antes de continuar,
 * de modo que un fallo parcial no pierde el trabajo ya hecho.
 *
 * El LLM siempre usa las credenciales del bot indicado en la solicitud.
 */

import { randomUUID } from 'node:crypto'

import { db } from '../db'
import { decrypt } from '../crypto'
import { logger } from '../logger'
import { getLLMProvider } from '../providers/llm'
import { cargarSkill } from '../forge/skill-loader'
import { orquestar } from '../forge/extract/orquestador'
import { validarFicha } from '../forge/intake/validar-ficha'
import { validarPlan } from '../forge/sources/validar-plan'
import { validarEncargo } from '../forge/analyze/validar-encargo'
import { fabricarSkill } from '../forge/factory/fabricar-skill'
import type { PlanExtraccion } from '../forge/extract/types'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface EntradaSolicitud {
  botId: string
  orgId: string
  problema: string
}

// ─── Crear solicitud ──────────────────────────────────────────────────────────

export async function crearSolicitud(entrada: EntradaSolicitud): Promise<string> {
  const solicitud = await db.solicitud.create({
    data: {
      orgId: entrada.orgId,
      botId: entrada.botId,
      problema: entrada.problema,
      estado: 'pendiente',
    },
    select: { id: true },
  })
  return solicitud.id
}

// ─── Procesar pipeline completo ───────────────────────────────────────────────

export async function procesarSolicitud(solicitudId: string): Promise<void> {
  // 1. Cargar solicitud y credenciales del bot
  const solicitud = await db.solicitud.findUnique({
    where: { id: solicitudId },
    include: {
      bot: {
        select: {
          llmProvider: true,
          llmModel: true,
          llmApiKeyEnc: true,
        },
      },
    },
  })

  if (!solicitud) throw new Error(`Solicitud '${solicitudId}' no encontrada.`)

  const { bot } = solicitud
  if (!bot.llmProvider || !bot.llmModel || !bot.llmApiKeyEnc) {
    await marcarError(solicitudId, 'El bot no tiene credenciales LLM configuradas.')
    return
  }

  const apiKey = decrypt(bot.llmApiKeyEnc)
  const llmProvider = bot.llmProvider
  const llmModel = bot.llmModel
  const provider = getLLMProvider(llmProvider)

  await db.solicitud.update({ where: { id: solicitudId }, data: { estado: 'procesando' } })

  try {
    // ── Paso A: forge-intake — NL → FICHA ─────────────────────────────────────
    logger.info({ solicitudId }, 'forge-intake: generando FICHA')
    const intakeSkill = await cargarSkill('forge-intake', solicitud.orgId)
    const intakeResp = await provider.complete({
      systemPrompt: intakeSkill.contenido,
      history: [],
      userMessage: solicitud.problema,
      apiKey,
      model: llmModel,
      params: { max_tokens: 2048 },
    })
    const ficha = extraerJson(intakeResp.text, 'forge-intake')
    const fichaVal = validarFicha(ficha)
    if (!fichaVal.valida) {
      throw new Error(`FICHA inválida: ${fichaVal.errores.join(' | ')}`)
    }
    await db.solicitud.update({ where: { id: solicitudId }, data: { fichaJson: ficha as object } })

    // ── Paso B: forge-sources — FICHA → PLAN ──────────────────────────────────
    logger.info({ solicitudId }, 'forge-sources: generando PLAN')
    const sourcesSkill = await cargarSkill('forge-sources', solicitud.orgId)
    const sourcesResp = await provider.complete({
      systemPrompt: sourcesSkill.contenido,
      history: [],
      userMessage: JSON.stringify(ficha),
      apiKey,
      model: llmModel,
      params: { max_tokens: 2048 },
    })
    const plan = extraerJson(sourcesResp.text, 'forge-sources')
    const fichaObj = ficha as Record<string, unknown>
    const datosRequeridos = (fichaObj['datos_requeridos'] as string[] | undefined) ?? []
    const planVal = validarPlan(plan, datosRequeridos)
    if (!planVal.valida) {
      throw new Error(`PLAN inválido: ${planVal.errores.join(' | ')}`)
    }
    await db.solicitud.update({ where: { id: solicitudId }, data: { planJson: plan as object } })

    // ── Paso C: forge-extract — PLAN → ResultadoExtraccion (mecánico) ─────────
    logger.info({ solicitudId }, 'forge-extract: orquestando extracción')
    const planExtraccion = plan as unknown as PlanExtraccion
    const extraccion = await orquestar(planExtraccion, {})
    await db.solicitud.update({ where: { id: solicitudId }, data: { extraccionJson: extraccion as unknown as object } })

    // ── Paso D: forge-analyze — {FICHA+PLAN+extracción} → ENCARGO ─────────────
    logger.info({ solicitudId }, 'forge-analyze: generando ENCARGO')
    const analyzeSkill = await cargarSkill('forge-analyze', solicitud.orgId)
    const analyzeInput = JSON.stringify({ ficha, plan, extraccion })
    const analyzeResp = await provider.complete({
      systemPrompt: analyzeSkill.contenido,
      history: [],
      userMessage: analyzeInput,
      apiKey,
      model: llmModel,
      params: { max_tokens: 3000 },
    })
    const encargo = extraerJson(analyzeResp.text, 'forge-analyze')
    const encargoVal = validarEncargo(encargo, extraccion)
    if (!encargoVal.valida) {
      throw new Error(`ENCARGO inválido: ${encargoVal.errores.join(' | ')}`)
    }
    await db.solicitud.update({ where: { id: solicitudId }, data: { encargoJson: encargo as object } })

    const encargoObj = encargo as Record<string, unknown>
    const decision = encargoObj['decision'] as string | undefined

    let skillId: string | undefined
    let skillVersion: number | undefined

    // ── Paso E (condicional): FACTORY — ENCARGO → SKILL.md ────────────────────
    if (decision === 'fabricar' || decision === 'modificar') {
      logger.info({ solicitudId, decision }, 'factory: fabricando skill')
      const resultado = await fabricarSkill({
        encargo: encargoObj,
        orgId: solicitud.orgId,
        llmProvider,
        llmModel,
        apiKey,
      })
      skillId = resultado.skillId
      skillVersion = resultado.version
      await db.solicitud.update({ where: { id: solicitudId }, data: { skillId } })
    } else if (decision === 'reusar') {
      // Buscar el skill existente
      const skillName = String(encargoObj['skill_objetivo'] ?? '').trim()
      if (skillName) {
        const skillExistente = await db.skill.findFirst({
          where: { orgId: solicitud.orgId, name: skillName, forgeApproved: true },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        })
        if (skillExistente) {
          skillId = skillExistente.id
          skillVersion = skillExistente.version
          await db.solicitud.update({ where: { id: solicitudId }, data: { skillId } })
        }
      }
    }

    // ── Paso F (condicional): forge-loop — configurar lazo continuo ────────────
    const ejeTemporal = (fichaObj['eje_temporal'] as Record<string, unknown> | undefined) ?? {}
    const isContinuo = ejeTemporal['tipo'] === 'continuo'
    const fabricoNuevo = decision === 'fabricar' || decision === 'modificar'

    if (isContinuo) {
      logger.info({ solicitudId }, 'forge-loop: configurando lazo continuo')
      const loopId = await configurarLazo({
        fichaObj,
        encargoObj,
        orgId: solicitud.orgId,
        solicitudId,
        skillId,
        skillVersion,
      })
      await db.solicitud.update({ where: { id: solicitudId }, data: { loopId } })
      await db.solicitud.update({ where: { id: solicitudId }, data: { estado: 'completado' } })
    } else if (fabricoNuevo && skillId) {
      await db.solicitud.update({ where: { id: solicitudId }, data: { estado: 'esperando_aprobacion' } })
    } else {
      await db.solicitud.update({ where: { id: solicitudId }, data: { estado: 'completado' } })
    }
    logger.info({ solicitudId }, 'solicitud completada')

  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err)
    logger.error({ solicitudId, detalle }, 'error en pipeline forge')
    await marcarError(solicitudId, detalle)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extraerJson(texto: string, paso: string): unknown {
  // Intenta extraer JSON de bloque markdown o del texto completo
  const bloqueMatch = texto.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidato = bloqueMatch ? bloqueMatch[1].trim() : texto.trim()
  try {
    return JSON.parse(candidato)
  } catch {
    throw new Error(`${paso}: el LLM no devolvió JSON válido. Respuesta: ${candidato.slice(0, 200)}`)
  }
}

async function marcarError(solicitudId: string, detalle: string): Promise<void> {
  await db.solicitud.update({
    where: { id: solicitudId },
    data: { estado: 'error', errorDetalle: detalle.slice(0, 2000) },
  })
}

// ─── Configurar LoopState ─────────────────────────────────────────────────────

interface EntradaLoopState {
  fichaObj: Record<string, unknown>
  encargoObj: Record<string, unknown>
  orgId: string
  solicitudId: string
  skillId: string | undefined
  skillVersion: number | undefined
}

async function configurarLazo(entrada: EntradaLoopState): Promise<string> {
  const { fichaObj, encargoObj, orgId, solicitudId, skillId, skillVersion } = entrada

  const ejeTemporal = (fichaObj['eje_temporal'] as Record<string, unknown>) ?? {}
  const ritmoStr = String(ejeTemporal['ritmo'] ?? 'diario').toLowerCase()
  const ritmo = parsearRitmo(ritmoStr)

  const skillName = String(encargoObj['skill_objetivo'] ?? 'skill-sin-nombre').trim()
  const ahora = new Date()

  const proximaEjecucion = ritmo.tipo === 'cron'
    ? calcularProximaCronSimple(ritmo.valor, ahora)
    : null

  const loopId = `loop-${solicitudId.slice(0, 8)}-${Date.now()}`

  await db.loopState.create({
    data: {
      loopId,
      fichaId: solicitudId,
      orgId,
      ritmo: ritmo as object,
      estadoOperativo: skillId ? 'pausado' : 'activo', // pausado si skill necesita aprobación
      proximaEjecucion,
      ejecucionesTotales: 0,
      skillOperante: {
        name: skillName,
        version: skillVersion ?? 1,
        approvedAt: ahora.toISOString(),
      } as object,
      fallosConsecutivos: 0,
      pendienteAprobacion: Boolean(skillId), // true si se fabricó un skill que necesita aprobación
      politicaAdaptacion: {
        adaptarSi: 'cobertura < 60% o fuentes críticas no responden',
        noAdaptarSi: 'variación normal de contenido sin pérdida de cobertura',
        maxAdaptacionesPorPeriodo: 3,
        periodoHoras: 24,
        extraccionVaciaEsFallo: true,
      } as object,
      adaptacionesEnPeriodo: { periodoInicio: '', count: 0 } as object,
      historial: [] as object[],
    },
  })

  return loopId
}

function parsearRitmo(ritmoStr: string): { tipo: 'cron'; valor: string } | { tipo: 'umbral'; metrica: string; operador: string; valorUmbral: number } {
  if (ritmoStr.includes('hora')) {
    const n = parseInt(ritmoStr.match(/\d+/)?.[0] ?? '1', 10)
    return { tipo: 'cron', valor: `0 */${n} * * *` }
  }
  if (ritmoStr.includes('semanal') || ritmoStr.includes('semana')) {
    return { tipo: 'cron', valor: '0 9 * * 1' }
  }
  if (ritmoStr.includes('mensual') || ritmoStr.includes('mes')) {
    return { tipo: 'cron', valor: '0 9 1 * *' }
  }
  // Defecto: diario a las 9am UTC
  return { tipo: 'cron', valor: '0 9 * * *' }
}

function calcularProximaCronSimple(expresion: string, desde: Date): Date {
  const parts = expresion.trim().split(/\s+/)
  if (parts.length !== 5) return new Date(desde.getTime() + 86_400_000)
  const [, hour] = parts
  if (hour.startsWith('*/')) {
    const n = parseInt(hour.slice(2), 10)
    if (!isNaN(n) && n >= 1) return new Date(desde.getTime() + n * 3_600_000)
  }
  if (hour === '*') return new Date(desde.getTime() + 3_600_000)
  return new Date(desde.getTime() + 86_400_000)
}
