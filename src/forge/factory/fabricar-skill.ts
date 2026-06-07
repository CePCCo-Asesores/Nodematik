/**
 * Adaptador FACTORY (paso 8.4) — fabrica un SKILL.md usando el LLM.
 *
 * Recibe el ENCARGO de forge-analyze, llama al LLM con factory/SKILL.md
 * como system prompt, y persiste el resultado en la tabla `skills` con
 * forgeApproved: false. El gate humano cambia ese campo a true.
 *
 * El FACTORY siempre produce skills con forgeApproved: false — nunca opera
 * ningún skill recién generado sin aprobación.
 */

import { db } from '../../db'
import { cargarSkill } from '../skill-loader'
import { getLLMProvider } from '../../providers/llm'

// ─── Tipos de entrada/salida ──────────────────────────────────────────────────

export interface EntradaFactory {
  encargo: Record<string, unknown>
  orgId: string
  llmProvider: string
  llmModel: string
  apiKey: string
}

export interface ResultadoFactory {
  skillId: string
  skillName: string
  version: number
  contenido: string
}

// ─── Función principal ─────────────────────────────────────────────────────────

export async function fabricarSkill(entrada: EntradaFactory): Promise<ResultadoFactory> {
  const { encargo, orgId, llmProvider, llmModel, apiKey } = entrada

  // Cargar factory/SKILL.md como system prompt
  const factorySkill = await cargarSkill('factory', orgId)
  const provider = getLLMProvider(llmProvider)

  // El LLM recibe la especificacion_factory + contexto del encargo
  const userMessage = JSON.stringify({
    especificacion_factory: encargo['especificacion_factory'],
    skill_objetivo: encargo['skill_objetivo'],
    decision: encargo['decision'],
    nivel_generalizacion: encargo['nivel_generalizacion'],
    evidencia_usada: encargo['evidencia_usada'],
    basado_en_datos_completos: encargo['basado_en_datos_completos'],
  }, null, 2)

  const response = await provider.complete({
    systemPrompt: factorySkill.contenido,
    history: [],
    userMessage,
    apiKey,
    model: llmModel,
    params: { max_tokens: 4096 },
  })

  // factory/SKILL.md produce un archivo SKILL.md en texto, no JSON
  const contenido = response.text.trim()

  const skillName = String(encargo['skill_objetivo'] ?? 'skill-sin-nombre')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')

  const decision = String(encargo['decision'] ?? 'fabricar')
  const verboCentral = decision === 'modificar' ? 'modificar' : 'fabricar'
  const nivelGeneralizacion = String(encargo['nivel_generalizacion'] ?? 'cliente')

  // Calcular la siguiente versión para este skill
  const ultimaVersion = await db.skill.findFirst({
    where: { orgId, name: skillName },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const version = (ultimaVersion?.version ?? 0) + 1

  const skill = await db.skill.create({
    data: {
      orgId,
      name: skillName,
      version,
      content: contenido,
      verboCentral,
      nivelGeneralizacion,
      forgeApproved: false,        // gate: nunca operar sin aprobación humana
      requiereRevisionHumana: true,
    },
  })

  return {
    skillId: skill.id,
    skillName: skill.name,
    version: skill.version,
    contenido,
  }
}
