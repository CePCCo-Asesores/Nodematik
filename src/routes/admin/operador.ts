/**
 * Rutas REST del Operador Autónomo FORGE (paso 8.8).
 *
 * POST /admin/operador/solicitudes              — enviar problema NL (inicia conversación)
 * GET  /admin/operador/solicitudes/:id          — estado de la solicitud
 * POST /admin/operador/solicitudes/:id/responder — continuar conversación (Chat A)
 * GET  /admin/operador/loops/:loopId            — estado del lazo
 * POST /admin/operador/loops/:loopId/aprobaciones — aprobar skill pendiente
 *
 * Aislamiento de org: req.user.orgId debe coincidir con el recurso.
 * Superadmin (isSuperadmin) puede acceder a cualquier org.
 */

import type { FastifyPluginAsync } from 'fastify'
import { db } from '../../db'
import { encolarSolicitud } from '../../queue/forge-scheduler'
import { getLLMProvider } from '../../providers/llm'
import { decrypt } from '../../crypto'

const INTAKE_SYSTEM_PROMPT = `Eres el operador de Nodematik. Tu trabajo es entender el problema del usuario para construir una solución autónoma.
Haz preguntas de clarificación (una a la vez, conversacionalmente) hasta tener toda la información.
Cuando tengas suficiente información, responde ÚNICAMENTE con un JSON válido con la FICHA del problema (no incluyas nada más).
La FICHA debe tener: { "titulo": string, "descripcion": string, "objetivo": string, "contexto": string, "criterios_exito": string[], "tipo_solucion": "continua"|"entrega_unica", "vertical": string }`

type MensajeConversacion = { rol: 'usuario' | 'operador'; mensaje: string; timestamp: string }

const operadorRoutes: FastifyPluginAsync = async (fastify) => {

  // ── POST /operador/solicitudes ────────────────────────────────────────────
  // Creates solicitud and asks the FIRST clarifying question via LLM.
  fastify.post<{
    Body: { botId: string; problema: string }
  }>('/solicitudes', async (req, reply) => {
    const { botId, problema } = req.body

    if (!botId || typeof botId !== 'string') {
      return reply.status(400).send({ error: "'botId' es requerido." })
    }
    if (!problema || typeof problema !== 'string' || !problema.trim()) {
      return reply.status(400).send({ error: "'problema' es requerido y no puede estar vacío." })
    }

    const user = req.user!

    // Verificar que el bot pertenece a la org del usuario
    const bot = await db.bot.findUnique({
      where: { id: botId },
      select: { orgId: true, llmProvider: true, llmModel: true, llmApiKeyEnc: true },
    })
    if (!bot) return reply.status(404).send({ error: 'Bot no encontrado.' })
    if (!user.isSuperadmin && bot.orgId !== user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }
    if (!bot.llmProvider || !bot.llmModel || !bot.llmApiKeyEnc) {
      return reply.status(422).send({ error: 'El bot no tiene credenciales LLM configuradas.' })
    }

    const problemaTrimmed = problema.trim()

    // Ask first clarifying question via LLM before persisting solicitud
    let primeraPregunta: string | null = null
    try {
      const apiKey = decrypt(bot.llmApiKeyEnc)
      const llm = getLLMProvider(bot.llmProvider)
      const result = await llm.complete({
        systemPrompt: INTAKE_SYSTEM_PROMPT,
        history: [],
        userMessage: problemaTrimmed,
        apiKey,
        model: bot.llmModel,
        params: { max_tokens: 1024 },
      })
      primeraPregunta = result.text.trim()
    } catch {
      // LLM failed — create solicitud and enqueue directly
      const solicitud = await db.solicitud.create({
        data: { orgId: bot.orgId, botId, problema: problemaTrimmed, estado: 'pendiente' },
        select: { id: true },
      })
      await encolarSolicitud(solicitud.id)
      return reply.status(202).send({ id: solicitud.id, estado: 'pendiente', pregunta: null })
    }

    const isJson = primeraPregunta.startsWith('{')
    const conversacion: MensajeConversacion[] = [
      { rol: 'usuario', mensaje: problemaTrimmed, timestamp: new Date().toISOString() },
      {
        rol: 'operador',
        mensaje: isJson ? 'Entendido. Construyendo tu solución...' : primeraPregunta,
        timestamp: new Date().toISOString(),
      },
    ]

    if (isJson) {
      // LLM already has enough info — create solicitud and enqueue immediately
      let fichaJson: object
      try { fichaJson = JSON.parse(primeraPregunta) } catch { fichaJson = {} }
      const solicitud = await db.solicitud.create({
        data: {
          orgId: bot.orgId,
          botId,
          problema: problemaTrimmed,
          estado: 'procesando',
          fichaJson,
          conversacion: conversacion as object[],
        },
        select: { id: true },
      })
      await encolarSolicitud(solicitud.id)
      return reply.status(202).send({ id: solicitud.id, estado: 'procesando', pregunta: null })
    }

    // Normal path: create solicitud awaiting first user reply
    const solicitud = await db.solicitud.create({
      data: {
        orgId: bot.orgId,
        botId,
        problema: problemaTrimmed,
        estado: 'esperando_respuesta',
        conversacion: conversacion as object[],
      },
      select: { id: true },
    })
    return reply.status(202).send({ id: solicitud.id, estado: 'esperando_respuesta', pregunta: primeraPregunta })
  })

  // ── GET /operador/solicitudes/:id ─────────────────────────────────────────
  fastify.get<{
    Params: { id: string }
  }>('/solicitudes/:id', async (req, reply) => {
    const { id } = req.params
    const user = req.user!

    const solicitud = await db.solicitud.findUnique({
      where: { id },
      select: {
        id: true,
        orgId: true,
        botId: true,
        problema: true,
        estado: true,
        fichaJson: true,
        planJson: true,
        extraccionJson: true,
        encargoJson: true,
        skillId: true,
        loopId: true,
        errorDetalle: true,
        conversacion: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!solicitud) return reply.status(404).send({ error: 'Solicitud no encontrada.' })
    if (!user.isSuperadmin && solicitud.orgId !== user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    return reply.send(solicitud)
  })

  // ── POST /operador/solicitudes/:id/responder ──────────────────────────────
  // Continúa la conversación: append user message, call LLM, detect FICHA or pregunta.
  fastify.post<{
    Params: { id: string }
    Body: { mensaje: string }
  }>('/solicitudes/:id/responder', async (req, reply) => {
    const { id } = req.params
    const { mensaje } = req.body ?? {}
    const user = req.user!

    if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) {
      return reply.status(400).send({ error: "'mensaje' es requerido." })
    }

    const solicitud = await db.solicitud.findUnique({
      where: { id },
      select: { id: true, orgId: true, botId: true, estado: true, conversacion: true, problema: true },
    })
    if (!solicitud) return reply.status(404).send({ error: 'Solicitud no encontrada.' })
    if (!user.isSuperadmin && solicitud.orgId !== user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }
    if (solicitud.estado !== 'esperando_respuesta' && solicitud.estado !== 'pendiente') {
      return reply.status(400).send({ error: `La solicitud no acepta respuestas (estado: ${solicitud.estado}).` })
    }

    const bot = await db.bot.findUnique({
      where: { id: solicitud.botId },
      select: { llmProvider: true, llmModel: true, llmApiKeyEnc: true },
    })
    if (!bot?.llmProvider || !bot.llmModel || !bot.llmApiKeyEnc) {
      return reply.status(422).send({ error: 'Bot sin credenciales LLM.' })
    }

    const conversacion = (Array.isArray(solicitud.conversacion) ? solicitud.conversacion : []) as MensajeConversacion[]
    conversacion.push({ rol: 'usuario', mensaje: mensaje.trim(), timestamp: new Date().toISOString() })

    // Build LLM history from previous conversacion entries (exclude the message we just added)
    const history = conversacion.slice(0, -1).map(m => ({
      role: m.rol === 'usuario' ? ('user' as const) : ('assistant' as const),
      content: m.mensaje,
    }))

    const apiKey = decrypt(bot.llmApiKeyEnc)
    const llm = getLLMProvider(bot.llmProvider)
    const result = await llm.complete({
      systemPrompt: INTAKE_SYSTEM_PROMPT,
      history,
      userMessage: mensaje.trim(),
      apiKey,
      model: bot.llmModel,
      params: { max_tokens: 1024 },
    })
    const respuesta = result.text.trim()
    const isJson = respuesta.startsWith('{')

    conversacion.push({
      rol: 'operador',
      mensaje: isJson ? 'Entendido. Construyendo tu solución...' : respuesta,
      timestamp: new Date().toISOString(),
    })

    if (isJson) {
      let fichaJson: object
      try { fichaJson = JSON.parse(respuesta) } catch { fichaJson = {} }
      await db.solicitud.update({
        where: { id },
        data: { fichaJson, conversacion: conversacion as object[], estado: 'procesando' },
      })
      await encolarSolicitud(id)
      return reply.send({ respuesta: 'Entendido. Construyendo tu solución...', estado: 'procesando', siguiente: 'procesando' })
    }

    await db.solicitud.update({
      where: { id },
      data: { conversacion: conversacion as object[], estado: 'esperando_respuesta' },
    })
    return reply.send({ respuesta, estado: 'esperando_respuesta', siguiente: 'pregunta' })
  })

  // ── GET /operador/loops/:loopId ───────────────────────────────────────────
  fastify.get<{
    Params: { loopId: string }
  }>('/loops/:loopId', async (req, reply) => {
    const { loopId } = req.params
    const user = req.user!

    const loop = await db.loopState.findUnique({
      where: { loopId },
      select: {
        loopId: true,
        orgId: true,
        fichaId: true,
        ritmo: true,
        estadoOperativo: true,
        ultimaEjecucion: true,
        proximaEjecucion: true,
        ejecucionesTotales: true,
        fallosConsecutivos: true,
        huellaAnterior: true,
        skillOperante: true,
        ultimaAnomalia: true,
        pendienteAprobacion: true,
        politicaAdaptacion: true,
        cooldownAdaptacionHasta: true,
        adaptacionesEnPeriodo: true,
        historial: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!loop) return reply.status(404).send({ error: 'Lazo no encontrado.' })
    if (!user.isSuperadmin && loop.orgId !== user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    return reply.send(loop)
  })

  // ── POST /operador/solicitudes/:id/aprobaciones ──────────────────────────
  // Gate para skills fabricados en solicitudes únicas (eje_temporal == "unico").
  // Las solicitudes continuas tienen loop propio — usar /loops/:loopId/aprobaciones.
  fastify.post<{
    Params: { id: string }
    Body: { aprobado: boolean }
  }>('/solicitudes/:id/aprobaciones', async (req, reply) => {
    const { id } = req.params
    const { aprobado } = req.body
    const user = req.user!

    if (typeof aprobado !== 'boolean') {
      return reply.status(400).send({ error: "'aprobado' (boolean) es requerido." })
    }

    const solicitud = await db.solicitud.findUnique({
      where: { id },
      select: { orgId: true, skillId: true, loopId: true, estado: true },
    })

    if (!solicitud) return reply.status(404).send({ error: 'Solicitud no encontrada.' })
    if (!user.isSuperadmin && solicitud.orgId !== user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }
    if (!solicitud.skillId) {
      return reply.status(409).send({ error: 'La solicitud no tiene skill fabricado pendiente de aprobación.' })
    }
    if (solicitud.loopId) {
      return reply.status(409).send({
        error: 'Esta solicitud tiene un lazo activo. Usa POST /admin/operador/loops/:loopId/aprobaciones.',
      })
    }

    const skill = await db.skill.findUnique({
      where: { id: solicitud.skillId },
      select: { forgeApproved: true },
    })

    if (!skill) return reply.status(404).send({ error: 'Skill no encontrado.' })
    if (skill.forgeApproved) return reply.status(409).send({ error: 'El skill ya está aprobado.' })

    if (!aprobado) {
      await db.solicitud.update({
        where: { id },
        data: { estado: 'rechazado' },
      })
      return reply.send({ ok: true, accion: 'rechazado' })
    }

    await db.skill.update({
      where: { id: solicitud.skillId },
      data: {
        forgeApproved: true,
        approvedAt: new Date(),
        approvedBy: user.isSuperadmin ? 'superadmin' : user.userId,
      },
    })

    await db.solicitud.update({
      where: { id },
      data: { estado: 'aprobado' },
    })

    return reply.send({ ok: true, accion: 'aprobado', skillId: solicitud.skillId })
  })

  // ── POST /operador/loops/:loopId/aprobaciones ─────────────────────────────
  fastify.post<{
    Params: { loopId: string }
    Body: { aprobado: boolean }
  }>('/loops/:loopId/aprobaciones', async (req, reply) => {
    const { loopId } = req.params
    const { aprobado } = req.body
    const user = req.user!

    if (typeof aprobado !== 'boolean') {
      return reply.status(400).send({ error: "'aprobado' (boolean) es requerido." })
    }

    const loop = await db.loopState.findUnique({
      where: { loopId },
      select: {
        orgId: true,
        pendienteAprobacion: true,
        skillOperante: true,
        estadoOperativo: true,
      },
    })

    if (!loop) return reply.status(404).send({ error: 'Lazo no encontrado.' })
    if (!user.isSuperadmin && loop.orgId !== user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }
    if (!loop.pendienteAprobacion) {
      return reply.status(409).send({ error: 'El lazo no tiene aprobación pendiente.' })
    }

    if (!aprobado) {
      // Rechazar: detener el lazo
      await db.loopState.update({
        where: { loopId },
        data: { estadoOperativo: 'detenido', pendienteAprobacion: false },
      })
      return reply.send({ ok: true, accion: 'detenido' })
    }

    // Aprobar: marcar skill como aprobado + activar el lazo
    const skillOp = loop.skillOperante as Record<string, unknown>
    const skillName = skillOp['name'] as string | undefined
    const skillVersion = skillOp['version'] as number | undefined

    if (skillName && skillVersion !== undefined) {
      const skill = await db.skill.findFirst({
        where: { orgId: loop.orgId, name: skillName, version: skillVersion },
        select: { id: true },
      })
      if (skill) {
        await db.skill.update({
          where: { id: skill.id },
          data: {
            forgeApproved: true,
            approvedAt: new Date(),
            approvedBy: user.isSuperadmin ? 'superadmin' : user.userId,
          },
        })
      }
    }

    await db.loopState.update({
      where: { loopId },
      data: {
        estadoOperativo: 'activo',
        pendienteAprobacion: false,
      },
    })

    return reply.send({ ok: true, accion: 'activado' })
  })
}

export default operadorRoutes
