/**
 * Skill loader (paso 8.3) — carga un skill por nombre y org.
 *
 * Lógica de despacho:
 *   - Skills base (los 6 de infraestructura): lee SKILL.md del repo en filesystem.
 *   - Skills generados por cliente: consulta Prisma (tabla `skills`), filtra por org
 *     y forge_approved=true, devuelve la versión más reciente aprobada.
 *
 * El loader es la única pieza del sistema que conoce la diferencia entre
 * "skill de infraestructura" y "skill de cliente". El orquestador solo llama
 * cargarSkill(nombre, orgId) y recibe el mismo contrato en ambos casos.
 *
 * Paths en producción (Railway): el proceso corre desde el root del repo,
 * así que process.cwd() apunta al directorio con src/ disponible.
 * Esto es consistente con cómo se resuelven prisma/migrations/ en el deploy.
 */

import fs from 'node:fs'
import path from 'node:path'
import { db } from '../db'

// ─── Skills base — infraestructura compartida, viven en el repo ───────────────

const FORGE_BASE_SKILLS: ReadonlySet<string> = new Set([
  'forge-intake',
  'forge-sources',
  'forge-extract',
  'forge-analyze',
  'forge-loop',
  'factory',
])

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'forge', 'skills')

// ─── Contrato de salida ────────────────────────────────────────────────────────

export interface SkillCargado {
  nombre: string
  version: number
  contenido: string            // SKILL.md completo (el system prompt)
  forgeApproved: boolean
  requiereRevisionHumana: boolean
  validadores: unknown         // JSON de validadores asociados (o null)
  esBase: boolean
  frontmatter: SkillFrontmatter
}

export interface SkillFrontmatter {
  name: string
  forgeApproved: boolean
  forgeAutonomy: 'supervised' | 'semi' | 'autonomous'
  forgeOutputFormat: string
}

// ─── Función principal ─────────────────────────────────────────────────────────

export async function cargarSkill(nombre: string, orgId: string): Promise<SkillCargado> {
  if (FORGE_BASE_SKILLS.has(nombre)) {
    return cargarSkillBase(nombre)
  }
  return cargarSkillGenerado(nombre, orgId)
}

// ─── Skill base (filesystem) ───────────────────────────────────────────────────

function cargarSkillBase(nombre: string): SkillCargado {
  const skillPath = path.join(SKILLS_ROOT, nombre, 'SKILL.md')

  let contenido: string
  try {
    contenido = fs.readFileSync(skillPath, 'utf-8')
  } catch {
    throw new Error(
      `Skill base '${nombre}' no encontrado en ${skillPath}. ` +
      `Verificar que src/forge/skills/${nombre}/SKILL.md existe en el repo.`
    )
  }

  const frontmatter = parsearFrontmatter(contenido)

  return {
    nombre,
    version: 1,
    contenido,
    forgeApproved: frontmatter.forgeApproved,
    requiereRevisionHumana: false,
    validadores: null,
    esBase: true,
    frontmatter,
  }
}

// ─── Skill generado (base de datos) ───────────────────────────────────────────

async function cargarSkillGenerado(nombre: string, orgId: string): Promise<SkillCargado> {
  const skill = await db.skill.findFirst({
    where: { orgId, name: nombre, forgeApproved: true },
    orderBy: { version: 'desc' },
  })

  if (!skill) {
    throw new SkillNoEncontradoError(
      `Skill '${nombre}' no encontrado o no aprobado para org '${orgId}'. ` +
      `El skill debe existir en la tabla 'skills' con forge_approved=true.`
    )
  }

  const frontmatter = parsearFrontmatter(skill.content)

  return {
    nombre: skill.name,
    version: skill.version,
    contenido: skill.content,
    forgeApproved: skill.forgeApproved,
    requiereRevisionHumana: skill.requiereRevisionHumana,
    validadores: skill.validators,
    esBase: false,
    frontmatter,
  }
}

// ─── Parser de frontmatter ─────────────────────────────────────────────────────
// Parser minimal — solo extrae los campos que el loader necesita.
// El frontmatter usa block scalar (>-) en algunos campos; este parser
// solo lee valores en la misma línea que la clave (formato simple).

function parsearFrontmatter(contenido: string): SkillFrontmatter {
  const match = contenido.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    return {
      name: '',
      forgeApproved: false,
      forgeAutonomy: 'semi',
      forgeOutputFormat: 'text',
    }
  }

  const yamlBlock = match[1]
  const kv: Record<string, string> = {}

  for (const line of yamlBlock.split('\n')) {
    // Solo procesar líneas sin sangría (claves de primer nivel)
    if (line.startsWith(' ') || line.startsWith('\t')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const rawVal = line.slice(colonIdx + 1).trim()
    if (rawVal && !rawVal.startsWith('>')) {
      kv[key] = rawVal.replace(/^['"]|['"]$/g, '')
    }
  }

  const autonomy = kv['forge_autonomy']
  const validAutonomy = (s: string): s is SkillFrontmatter['forgeAutonomy'] =>
    s === 'supervised' || s === 'semi' || s === 'autonomous'

  return {
    name: kv['name'] ?? '',
    forgeApproved: kv['forge_approved'] === 'true',
    forgeAutonomy: validAutonomy(autonomy) ? autonomy : 'semi',
    forgeOutputFormat: kv['forge_output_format'] ?? 'text',
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

export class SkillNoEncontradoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillNoEncontradoError'
  }
}

/** Lista los nombres de skills base disponibles. */
export function listarSkillsBase(): string[] {
  return [...FORGE_BASE_SKILLS]
}

/** Verifica si un nombre corresponde a un skill base. */
export function esSkillBase(nombre: string): boolean {
  return FORGE_BASE_SKILLS.has(nombre)
}
