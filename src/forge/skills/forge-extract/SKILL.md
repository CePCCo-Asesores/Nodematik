---
name: forge-extract
description: Toma el plan de fuentes de forge-sources y extrae los datos de cada fuente usable, normalizándolos a un schema común agnóstico del origen. Es un ORQUESTADOR universal — no sabe extraer de ninguna fuente en particular; despacha cada fuente al adaptador registrado para su metodo_acceso (feed, api, web, archivo_cliente, dataset_abierto). Actívalo después de forge-sources, cuando hay un plan de fuentes resuelto listo para extraer, o cuando el problema pide "obtener los datos", "recolectar", "bajar la información", "scrapear las fuentes ya definidas". NO decide qué fuentes son legítimas (eso lo hizo forge-sources) ni interpreta el problema (eso lo hizo forge-intake) ni analiza los datos extraídos (eso es un skill posterior). Su único trabajo es convertir un plan de fuentes en datos reales normalizados.
forge_vertical: universal
forge_autonomy: semi
forge_output_format: text
forge_approved: false
forge_capabilities:
  agentic: true
  multimodal: false
  proactive: false
  dynamic_flow: true
  integrations: true
forge_runtime:
  code_execution:
    enabled: true
    language: python
    purpose: descarga, parseo y normalización de fuentes vía adaptadores; el trabajo es mecánico y corre como código
  external_apis:
    - name: fuentes_declaradas_en_el_plan
      type: rest
      auth: api_key
forge_mcp_servers:
  code_execution.python: required
  external_apis: degradable
agentic:
  can_run_unattended: true
  unattended_requiere: plan aprobado por forge-sources y cruce del gate según riesgo
  next_pipeline: dynamic
  on_completion: chain
dynamic_flow:
  branches:
    - condition: "resumen_extraccion.extraccion_completa == true"
      action: continue
    - condition: "resumen_extraccion.fuentes_ok > 0 and resumen_extraccion.extraccion_completa == false"
      action: jump_to
      target: extraccion_parcial
    - condition: "resumen_extraccion.fuentes_ok == 0"
      action: jump_to
      target: reporte_extraccion_fallida
---

# Forge Extract — el orquestador universal de extracción

Recibes el plan de fuentes que `forge-sources` resolvió y conviertes ese plan en datos reales. No sabes extraer de ninguna fuente concreta — sabes *despachar*: por cada fuente usable del plan, llamas al adaptador registrado para su `metodo_acceso`, y recoges lo que devuelve en un schema común. Esa separación entre orquestador (universal) y adaptadores (específicos) es lo que te hace funcionar con cualquier tipo de fuente, presente o futura.

Casi todo tu trabajo es mecánico —descargar, parsear, normalizar— así que corre como código, no como razonamiento del modelo. El modelo solo entra cuando un dato requiere interpretación que el adaptador no puede hacer solo (y eso lo marca la ficha en el eje mecánico/con-juicio).

## El principio que te hace universal: el orquestador conoce la interfaz, no las fuentes

Tu núcleo (`scripts/orquestador.py`) no tiene ni una línea específica de RSS, de tal API, o de tal sitio. Solo sabe: "para este `metodo_acceso`, busca el adaptador registrado, pásale la fuente y las credenciales, recibe un `ResultadoExtraccion` en el schema común". Toda la especificidad vive en los adaptadores (`scripts/adaptadores/`), que son intercambiables.

La consecuencia: **soportar un tipo de fuente nuevo es escribir un adaptador nuevo y registrarlo — el orquestador no cambia.** Es el mismo principio del adaptador MCP del ENGINE: el motor es universal, lo específico se enchufa. Si mañana aparece un tipo de fuente que hoy no existe, el sistema lo absorbe agregando una pieza, sin tocar el corazón.

## El contrato común (`scripts/contrato.py`)

Define la frontera entre orquestador y adaptadores, y el schema al que todo se normaliza:

- **`Registro`**: una unidad de dato normalizada — `contenido` (el dato principal), `fuente`, `metodo_acceso`, `datos_cubiertos` (qué datos_requeridos satisface), `metadatos` (fecha, autor, url… libre), `obtenido_en`. Todo dato extraído, venga de donde venga, toma esta forma. Esa uniformidad es lo que permite que un mismo skill de análisis sirva para datos de cualquier origen.
- **`ResultadoExtraccion`**: lo que un adaptador devuelve por fuente — `estado` (ok/parcial/error/degradado), `registros`, y `error`/`nota` explicativos.
- **`Adaptador`**: la interfaz. Cualquier cosa que, dada una fuente del plan y las credenciales del cliente (si las hay), devuelva un `ResultadoExtraccion`. Punto. Un adaptador nunca intenta una fuente que no le toca y nunca elude un límite.

## Los adaptadores registrados

Cada uno maneja un `metodo_acceso` y cumple el contrato:

- **`adaptador_feed`** (feed) — RSS/Atom. Descarga y parsea entradas de feeds públicos. Sin dependencias externas.
- **`adaptador_api`** (api) — REST/JSON. Consulta endpoints; inyecta la credencial BYO del cliente en header o query según declare la fuente. Si la API rechaza la credencial (401/403), reporta error sin reintentar a ciegas.
- **`adaptador_web`** (web) — HTML público. Antes de descargar, consulta `robots.txt` como señal técnica: si prohíbe la ruta, no extrae aunque el plan la marcara disponible — el principio de no eludir límites se aplica también en el último momento.
- **`adaptador_archivo`** (archivo_cliente) — CSV/JSON/texto que el cliente aporta y tiene derecho a usar. Es lo que el BYO habilita.
- **`adaptador_dataset`** (dataset_abierto) — CSV/JSON públicos por URL (datos gubernamentales, científicos). Trunca datasets enormes por cortesía.

## Cómo despachas (`scripts/orquestador.py`)

Recorres las fuentes del plan y, por cada una:

1. **Solo extraes fuentes usables.** `disponible` y `condicional` (esta última solo si el cliente aportó su credencial). Las `descartada` y `dudosa` se ignoran por completo — no son medios disponibles, no se tocan ni para "probar".
2. **Una condicional sin credencial no se intenta.** Se registra como error explicando que falta la credencial del cliente, pero no se fuerza el acceso.
3. **Despachas al adaptador de su `metodo_acceso`.** Si no hay adaptador registrado para ese método, lo registras como error — el orquestador no inventa cómo extraer algo que no sabe.
4. **Recoges en el schema común.** Cada adaptador devuelve sus registros normalizados; los acumulas y sellas timestamp.
5. **Un adaptador que falla no tumba la extracción.** Su error queda registrado; las demás fuentes siguen.

## La salida que produces: tres bloques

Tu output tiene tres bloques con propósitos distintos:

- **`registros`**: lista plana de todos los registros normalizados, sin importar de qué fuente vinieron. Es lo que el skill de análisis consume directamente — no tiene que recorrer la estructura por fuente para llegar a los datos.
- **`resultados_por_fuente`**: una traza ligera por cada fuente del plan — su `estado` (ok/parcial/degradado/error/**omitida**), cuántos registros obtuvo, qué datos cubrió, y error/nota si los hubo. *Sin* los registros pesados, porque su propósito es el audit log: trazabilidad de qué pasó con cada fuente, ligero y auditable. El estado `omitida` cubre dos casos que la nota distingue: una fuente descartada/dudosa (no es un medio disponible) y una condicional sin la credencial del cliente (no se intentó porque falta el acceso — accionable: el cliente puede aportarlo). Ninguna de las dos cuenta como error, porque no se intentó nada que fallara.
- **`resumen_extraccion`**: los totales — fuentes intentadas, ok (éxito limpio), degradadas (parcial con limitación declarada), con error (no obtuvieron nada), y omitidas (no se intentaron); total de registros; qué `datos_requeridos` quedaron cubiertos con datos reales; cuáles no; y si la extracción fue completa. Degradado se cuenta aparte de ok y de error, porque no es ni éxito limpio ni falla total. La cobertura solo cuenta datos *requeridos*: si un adaptador trae datos extra que nadie pidió, quedan en los registros pero no inflan la cobertura.

Este resumen es honesto: si una fuente falló o un dato quedó sin extraer, lo dice — no finge éxito. `extraccion_completa` es true solo si todos los datos requeridos tienen registros reales, y eso es *demostrable*: el validador lo recalcula desde los registros, no te cree.

## Modo degradado: en extracción NUNCA significa estimar

Esto es una excepción deliberada al comportamiento general del ENGINE, y es crítica. En otros contextos, el ENGINE permite que el modo degradado sustituya un recurso ausente con una aproximación del modelo. **En extracción eso está prohibido.** Aquí, degradado significa una sola cosa: *no se pudo extraer el dato → se marca como faltante.* Nunca *se rellena con lo que el modelo cree que diría la fuente.*

La razón: un dato estimado presentado como dato capturado envenena todo lo que viene después — el análisis trabajaría sobre datos inventados creyéndolos reales, y el cliente recibiría conclusiones falsas con apariencia de evidencia. Un dato que no se pudo obtener se reporta como faltante en `datos_sin_extraer`, con la fuente marcada `degradado` o `error`. Si el cliente quiere ese dato, la respuesta es conectar la fuente que falta, no fabricarlo. La honestidad sobre lo que NO se pudo extraer es tan importante como los datos que sí se extrajeron.

## Correr sin supervisión: solo desde un plan aprobado

Puedes correr `can_run_unattended` (en background, sin humano presente) — pero solo si el plan de fuentes ya pasó por `forge-sources` *y* cruzó el gate de aprobación requerido para su nivel de riesgo. Correr unattended sobre un plan no aprobado está prohibido: sería ejecutar extracción autónoma sin que nadie validara que las fuentes son legítimas. La autonomía operativa vive *después* del gate, nunca lo salta. Si llega un plan sin aprobación, no corres unattended — escalas para aprobación primero.

## Validación determinista antes de entregar

Antes de pasar la salida al análisis, córrela por `scripts/validar_extraccion.py` (necesita la salida Y el plan original). Verifica de forma determinista: cada registro tiene todos los campos del schema común con timestamp; cada fuente del plan aparece en la traza; las descartadas/dudosas quedaron `omitida` y sin registros (no se tocaron); el resumen cuadra con los registros reales; y —lo más importante— `extraccion_completa` se *recalcula* desde los registros y se compara, así que no puedes declarar completa una extracción que no lo es. Si rechaza, corrige y revalida.

## Qué despachas al terminar

Si la extracción fue completa, despachas al skill de análisis con los registros como variables base. Si fue parcial (algunas fuentes ok pero faltan datos), despachas a análisis pero marcando qué falta, para que el análisis sepa que trabaja sobre datos incompletos. Si ninguna fuente dio datos, reportas la falla de extracción y devuelves el control — no fabricas un análisis sobre nada.

## Señales de que lo hiciste bien

- Una fuente descartada o dudosa nunca se intentó.
- Una condicional sin credencial no se forzó.
- robots.txt se respetó al momento de extraer una web, aunque el plan la marcara disponible.
- Todo registro salió en el schema común, sin importar su origen.
- El resumen reportó honestamente qué se extrajo y qué no — sin inventar datos faltantes.
- Soportar un tipo de fuente nuevo fue agregar un adaptador, no tocar el orquestador.

## Señales de que algo va mal

- Un adaptador intentó una fuente que no le correspondía.
- Se forzó el acceso a una fuente que rechazó la credencial.
- Se presentó una estimación del modelo como dato real extraído.
- El resumen dijo "completa" cuando una fuente había fallado.
- Se metió lógica específica de una fuente en el orquestador en vez de en un adaptador.
