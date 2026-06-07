# Nodematik — Operador autónomo de soluciones

Nodematik recibe un problema descrito en **lenguaje natural** y lo lleva de descripción cruda a solución viva. No es un chatbot ni un scraper: es el orquestador que **comprende** el problema, **decide** qué capacidad lo resuelve, la **construye** (reutilizando o fabricando skills), la **entrega**, y —si el problema es continuo— la **opera y la adapta** cuando el entorno cambia.

Está construido sobre la arquitectura **FORGE INDIGO** (ENGINE + FACTORY) y sobre una plataforma backend multi-tenant con credenciales propias del cliente (BYO), cifrado y cumplimiento LFPDPPP/ARCO. El único input del sistema es el problema del cliente; todo lo demás —el pipeline, los skills, las fuentes— lo deriva el operador.

## Qué hace, en una frase

Convierte un problema en lenguaje natural en una solución operada, en cualquier dominio, fabricando sobre la marcha las capacidades que le falten — con un gate de aprobación humana antes de que nada opere.

## Las funciones del operador

```
problema (lenguaje natural)
  → COMPRENDER   forge-intake    NL → FICHA (clasifica en dos ejes)
  → DECIDIR      forge-sources   FICHA → PLAN de fuentes legítimas
                 forge-extract   PLAN → datos normalizados            [determinista]
                 forge-analyze   datos → ENCARGO de fabricación
  → CONSTRUIR    factory         fabrica/parametriza el skill
  → [GATE]       aprobación humana — forge_approved: false hasta aprobar
  → OPERAR       forge-loop      vigila y adapta, si es continuo       [determinista]
```

**Los dos ejes que el operador infiere del problema** (el corazón de la fase Comprender):

- **Continuo vs. único** — ¿la solución vive en un lazo que vigila (una campaña que seguir) o se entrega una vez y termina (diseñar un menú)? Decide si entra a `forge-loop`.
- **Mecánico vs. con-juicio** — por cada paso, ¿es ejecución determinista (corre como código) o requiere razonar (llama al LLM)? Decide cómo se ejecuta cada pieza.

**El lazo de retorno**: cuando `forge-loop` detecta que la capacidad dejó de servir (una fuente murió, cae la cobertura), vuelve a `forge-analyze`, que reformula el encargo a la factory; la adaptación cruza el gate de nuevo. Eso es lo que convierte la tubería en un operador vivo, no un pipeline de un solo uso.

## Universalidad: núcleo universal, dominio en los bordes

El operador razona igual en cualquier campo (marketing, legal, clínico, educativo). Lo específico de cada dominio no vive en el núcleo — vive en skills de contexto que la FACTORY fabrica. Extender el operador a un dominio nuevo no es reprogramarlo: es describirle el dominio a la FACTORY. Es el mismo patrón engine↔vertical de FORGE, aplicado al corazón del operador.

## Dos clases de skill, dos lugares

- **Skills base** (la tubería + factory): infraestructura compartida, universal. Viven en el repo en `src/forge/skills/` (como `SKILL.md` + validadores de referencia en Python) y su lógica determinista traducida a TypeScript en `src/forge/`.
- **Skills generados por el cliente** (vía la FACTORY): específicos de un cliente/vertical, nacen con `forge_approved: false`, pasan por el gate y se guardan en la base de datos (modelo `Skill`), ligados a una organización.

Lo que es infraestructura compartida = código (repo). Lo que es contenido generado y propiedad de un cliente = datos (BD).

## Invariantes (no se negocian)

- **El gate manda**: nada opera sin aprobación humana. Modificar o fabricar un skill siempre exige re-aprobación. La autonomía vive en *decidir y proponer*; el control humano vive en la frontera producción→operación.
- **Trazabilidad causal**: fuente (`id`) → registro (`registro_id`) → evidencia en el encargo.
- **Disponible = accesible + permitido**: una fuente solo se usa si es técnicamente accesible y legalmente permitida (ToS, robots.txt, LFPDPPP). Las credenciales BYO del cliente definen su perímetro.
- **Honestidad**: los validadores demuestran por recálculo, no confían; no se declara cobertura completa con datos parciales ni se inventa evidencia.
- **El lazo es estado en reposo**, no proceso 24/7: corre en ráfagas cuando el scheduler lo despierta, con frenos contra hiperactividad (cooldown + techo de adaptaciones) y pausa tras fallos consecutivos.

## Arquitectura técnica

```
┌─────────────────┐     ┌─────────────────┐
│  Fastify (web)  │     │  BullMQ (worker) │
│  API operador   │────▶│  message queue   │
│  /admin         │     │  forge scheduler │
│  webhooks       │     │  concurrency=10  │
└─────────────────┘     └────────┬─────────┘
         │                       │
         └──────────┬── PostgreSQL (Prisma)
                    └── Redis (BullMQ)
```

- **Web**: API del operador (`/admin/operador`), rutas de administración (JWT), webhooks de canales (WhatsApp es uno de ellos, no el centro)
- **Worker**: ejecuta los pasos con-juicio llamando al LLM del cliente (BYO), corre los pasos deterministas como código, y opera el scheduler del lazo (ráfagas de soluciones continuas)

### Componentes FORGE en el repo

| Ruta | Qué es |
|------|--------|
| `src/forge/skills/` | Los SKILL.md base + validadores Python de referencia |
| `src/forge/intake\|sources\|analyze/` | Validadores deterministas en TS |
| `src/forge/extract/` | Orquestador universal + 5 adaptadores (feed, api, web, archivo, dataset) |
| `src/forge/loop/` | Estado, motor del lazo y validador (TS) |
| `src/forge/factory/` | Fabricación de skills desde el encargo |
| `src/forge/engine/FORGE_CORE.md` | El ENGINE (contrato universal) |
| `src/forge/skill-loader.ts` | Carga un skill del repo (base) o de la BD (generado) |
| `src/queue/forge-scheduler.ts` | Scheduler del lazo (repeatable job BullMQ) |
| `src/services/operador.service.ts` | Orquestador del encadenamiento de skills |
| `src/routes/admin/operador.ts` | API REST del operador, incluido el gate de aprobación |

### API del operador

| Endpoint | Qué hace |
|----------|----------|
| `POST /admin/operador/solicitudes` | Entra un problema en lenguaje natural y dispara la tubería |
| `GET /admin/operador/solicitudes/:id` | Estado de una solución |
| `GET /admin/operador/loops/:loopId` | Estado de un lazo continuo |
| `POST /admin/operador/loops/:loopId/aprobaciones` | Gate humano: aprueba/rechaza una capacidad o adaptación |

## Requisitos

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

## Instalación local

```bash
git clone <repo>
cd Nodematik
npm install
cp .env.example .env   # edita con tus valores reales
npm run db:generate
npm run db:migrate
```

## Variables de entorno

Ver `.env.example` para la lista completa. Las mínimas para arrancar:

| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `FIELD_ENCRYPTION_KEY` | Clave AES-256-GCM para cifrar credenciales (ver abajo) |
| `META_APP_SECRET` | App Secret de Meta para verificar webhooks de WhatsApp |
| `WEBHOOK_VERIFY_TOKEN` | Token de verificación del webhook |
| `JWT_SECRET` | Secreto para firmar tokens JWT |
| `ADMIN_API_KEY` | Clave de superadmin (header `x-admin-key`) |

## Correr en desarrollo

```bash
# Terminal 1 — servidor HTTP
npm run dev

# Terminal 2 — worker + scheduler del operador
npm run dev:worker
```

## Docker (desarrollo local)

```bash
cp .env.example .env   # DATABASE_URL y REDIS_URL los sobreescribe docker-compose
docker compose up --build
```

Levanta PostgreSQL, Redis, el servidor HTTP en `:3000` y el worker.

## Producción (Railway)

1. Crear dos servicios en Railway apuntando al mismo repositorio
2. **Servicio web** — usa `railway.toml` tal cual
3. **Servicio worker** — override startCommand: `node dist/worker.js`
4. Configurar las mismas variables de entorno en ambos servicios

Railway ejecuta `prisma migrate deploy` antes de arrancar el servidor web.

## Scripts disponibles

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Servidor de desarrollo con hot reload |
| `npm run dev:worker` | Worker + scheduler de desarrollo |
| `npm run build` | Compila TypeScript → `dist/` |
| `npm start` | Servidor de producción |
| `npm run worker` | Worker de producción |
| `npm run db:migrate` | Aplica migraciones pendientes |
| `npm run db:generate` | Regenera el cliente Prisma |
| `npm run db:studio` | Abre Prisma Studio (GUI) |
| `npm test` | Ejecuta tests |
| `npm run lint` | Type-check TypeScript |

## Tests

```bash
npm test
```

Cubre la plataforma base (auth, safety, quota, knowledge, aislamiento multi-tenant, resiliencia, crisis) y el operador FORGE (validadores de intake/sources/analyze y el motor del lazo). Los tests de FORGE viven en `tests/forge-*.test.ts`.

## FIELD_ENCRYPTION_KEY — Gestión de la clave maestra

Esta clave cifra **todas** las credenciales por cliente (API keys de LLM, credenciales de canal, integraciones). Si se pierde, los datos cifrados son irrecuperables.

### Generar

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Backup

Guardar en un gestor de secretos (Railway Variables, AWS Secrets Manager, Vault, Bitwarden) **antes** de usarla en producción. Nunca en el repositorio.

### Rotación de clave

La clave no admite rotación sin re-cifrar todos los registros:

```bash
# 1. Exportar todos los valores cifrados con la clave antigua
# 2. Descifrarlos con la clave antigua
# 3. Generar nueva FIELD_ENCRYPTION_KEY
# 4. Re-cifrarlos con la nueva clave y actualizar la DB
# 5. Rotar la variable de entorno en todos los servicios simultáneamente
```

Una rotación mal ejecutada (cambiar la env var sin re-cifrar primero) deja todos los clientes con error de credenciales. Hacer el re-cifrado en una transacción antes de cambiar la clave en producción.

## Seguridad

- Webhooks verificados con HMAC SHA-256 + `timingSafeEqual` (anti timing-attack)
- Rate limiting: 60 req/min en `/webhook`, 300 req/min global
- Credenciales cifradas con AES-256-GCM (autenticado), nunca en claro en logs
- Safety classifier independiente del LLM del cliente (`SAFETY_PROVIDER_API_KEY`)
- JWT 7 días + bypass superadmin por `x-admin-key`
- Aislamiento por organización en todas las rutas admin
- El operador FORGE nunca despliega una capacidad sin aprobación humana (gate)

## Cumplimiento (LFPDPPP / ARCO)

- Teléfonos de usuarios almacenados como SHA-256 hash (nunca en claro)
- Derecho de supresión: borra en cascada todos los datos del usuario
- Consentimiento explícito requerido antes de cualquier interacción
- `POLICY_VERSION` configurable para re-solicitar consentimiento al cambiar la política
