/**
 * Rutas REST del Operador Autónomo FORGE (paso 8.8).
 *
 * POST /admin/operador/solicitudes            — enviar problema NL
 * GET  /admin/operador/solicitudes/:id        — estado de la solicitud
 * GET  /admin/operador/loops/:loopId          — estado del lazo
 * POST /admin/operador/loops/:loopId/aprobaciones — aprobar skill pendiente
 *
 * Aislamiento de org: req.user.orgId debe coincidir con el recurso.
 * Superadmin (isSuperadmin) puede acceder a cualquier org.
 */

import type { FastifyPluginAsync } from 'fastify'
import { db } from '../../db'
import { crearSolicitud } from '../../services/operador.service'
import { encolarSolicitud } from '../../queue/forge-scheduler'

const operadorRoutes: FastifyPluginAsync = async (fastify) => {

  // ── POST /operador/solicitudes ────────────────────────────────────────────
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

    const solicitudId = await crearSolicitud({
      botId,
      orgId: bot.orgId,
      problema: problema.trim(),
    })

    await encolarSolicitud(solicitudId)

    return reply.status(202).send({ id: solicitudId, estado: 'pendiente' })
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
