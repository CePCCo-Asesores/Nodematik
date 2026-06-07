/**
 * Scheduler BullMQ para el Operador Autónomo FORGE (paso 8.7).
 *
 * Dos queues independientes:
 *   FORGE_PIPELINE_QUEUE — pipeline solicitudes + ráfagas de loop
 *   (el scheduler repeatable corre en el mismo queue con jobId fijo)
 *
 * El worker tiene concurrencia 3: suficiente para ráfagas paralelas
 * sin saturar las APIs externas de los adaptadores.
 */

import { Queue, Worker } from 'bullmq'
import { redisConnection } from './queue'
import { getPubClient } from '../lib/pubsub'
import { logger } from '../logger'
import { procesarSolicitud } from '../services/operador.service'
import { ejecutarRafaga, tickScheduler } from '../forge/loop/motor'
import { AlmacenEstadoPrisma } from '../forge/loop/almacen-prisma'

// ─── Queue ────────────────────────────────────────────────────────────────────

export const FORGE_QUEUE = 'forge-pipeline'

export const forgeQueue = new Queue(FORGE_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 2_000 },
  },
})

// ─── Tipos de job ─────────────────────────────────────────────────────────────

export interface ForgeSolicitudJob {
  type: 'solicitud'
  solicitudId: string
}

export interface ForgeRafagaJob {
  type: 'rafaga'
  loopId: string
}

export interface ForgeSchedulerTickJob {
  type: 'scheduler_tick'
}

export type ForgeJob = ForgeSolicitudJob | ForgeRafagaJob | ForgeSchedulerTickJob

// ─── Encolar solicitud ────────────────────────────────────────────────────────

export async function encolarSolicitud(solicitudId: string): Promise<void> {
  await forgeQueue.add('solicitud', { type: 'solicitud', solicitudId } satisfies ForgeSolicitudJob)
}

// ─── Iniciar worker + scheduler repeatable ────────────────────────────────────

export function startForgeWorker(): Worker {
  const redis = getPubClient()
  const almacen = new AlmacenEstadoPrisma(redis)

  const worker = new Worker<ForgeJob>(
    FORGE_QUEUE,
    async (job) => {
      const data = job.data

      if (data.type === 'solicitud') {
        await procesarSolicitud(data.solicitudId)
        return
      }

      if (data.type === 'rafaga') {
        const resultado = await ejecutarRafaga(data.loopId, almacen)
        logger.info({ loopId: data.loopId, evento: resultado.evento }, 'ráfaga forge completada')
        return
      }

      if (data.type === 'scheduler_tick') {
        const pendientes = await tickScheduler(almacen)
        for (const loopId of pendientes) {
          await forgeQueue.add('rafaga', { type: 'rafaga', loopId } satisfies ForgeRafagaJob, {
            jobId: `rafaga-${loopId}-${Date.now()}`,
            attempts: 1, // las ráfagas no se reintentan — el siguiente tick las recogerá si fallan
          })
        }
        if (pendientes.length > 0) {
          logger.info({ count: pendientes.length }, 'forge scheduler: loops encolados')
        }
      }
    },
    {
      connection: redisConnection,
      concurrency: 3,
      lockDuration: 120_000,
    },
  )

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, type: (job?.data as ForgeJob | undefined)?.type, err: err?.message },
      'forge job failed',
    )
  })

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'forge worker error')
  })

  return worker
}

// ─── Registrar scheduler repeatable ──────────────────────────────────────────
// Llamar una vez al iniciar el worker. El job se auto-deduplica por jobId.

export async function registrarSchedulerRepeatable(): Promise<void> {
  await forgeQueue.add(
    'scheduler_tick',
    { type: 'scheduler_tick' } satisfies ForgeSchedulerTickJob,
    {
      jobId: 'forge-scheduler-tick',  // jobId fijo → solo existe una instancia
      repeat: { every: 60_000 },      // cada 60 segundos
      attempts: 1,
    },
  )
  logger.info('forge scheduler repeatable registrado (cada 60s)')
}
