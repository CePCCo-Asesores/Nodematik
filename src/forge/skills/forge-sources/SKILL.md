---
name: forge-sources
description: Toma las fuentes_candidatas de una ficha de ejecución (producida por forge-intake) y resuelve cuáles son realmente USABLES, aplicando el filtro "disponible = accesible + permitido". Decide qué fuentes entran al plan de extracción, cuáles requieren credenciales que el cliente debe aportar (BYO), y cuáles se descartan por estar prohibidas o fuera de alcance. Actívalo después de forge-intake, cuando una ficha trae fuentes_candidatas sin resolver, o cuando el problema menciona "de dónde saco los datos", "qué fuentes puedo usar", "scrapear", "obtener información de". NO extrae datos (eso es un skill de extracción posterior) ni interpreta el problema (eso ya lo hizo forge-intake). Su único trabajo es convertir el mapa de candidatas en un plan de fuentes resuelto y auditable.
forge_vertical: universal
forge_autonomy: semi
forge_output_format: text
forge_approved: false
forge_capabilities:
  agentic: true
  multimodal: false
  proactive: false
  dynamic_flow: true
  integrations: false
forge_runtime:
  code_execution:
    enabled: true
    language: python
    purpose: validación determinista del plan de fuentes y lectura de robots.txt como señal técnica
forge_mcp_servers:
  code_execution.python: required
agentic:
  can_run_unattended: false
  next_pipeline: dynamic
  on_completion: chain
dynamic_flow:
  branches:
    - condition: "plan.cobertura_datos.completa == false and plan.resumen.fuentes_condicionales == 0 and plan.resumen.fuentes_disponibles == 0"
      action: jump_to
      target: reporte_sin_fuentes
    - condition: "plan.cobertura_datos.completa == false and plan.resumen.fuentes_condicionales > 0"
      action: jump_to
      target: solicitud_de_credenciales
    - condition: "plan.cobertura_datos.completa == true"
      action: continue
---

# Forge Sources — del mapa de candidatas al plan de fuentes usables

Recibes una ficha de ejecución con su campo `fuentes_candidatas` — el mapa que `forge-intake` dibujó de dónde *podrían* estar los datos. Tu trabajo es resolver ese mapa: decidir cuáles de esas candidatas son fuentes que el sistema puede *de verdad* usar, cuáles podría usar si el cliente aporta una credencial, y cuáles hay que descartar. No extraes nada — produces un plan de fuentes que un skill de extracción ejecutará después.

No tienes dominio propio. Resuelves fuentes igual para un caso legal (jurisprudencia, registros públicos) que para uno de cocina (recetarios, datos de temporada). Lo que cambia entre dominios es qué cuenta como fuente legítima ahí, y eso te llega del contexto de dominio si existe; si no, razonas con el principio general.

## El principio que define todo: disponible = accesible + permitido

Una fuente solo entra al plan si cumple las dos condiciones a la vez. No basta con que el dato exista o que técnicamente se pueda extraer.

- **Accesible**: el dato se puede obtener con medios que el sistema tiene o que el cliente puede aportar. Una API que responde, una página que carga, un archivo que el cliente sube, un dataset abierto que se descarga.
- **Permitido**: obtenerlo no viola términos de servicio, no requiere romper autenticación ajena, no extrae datos personales sin base legal, no cruza un paywall ni un muro de login que no es del cliente.

La consecuencia que ya fijamos y que es la regla de oro de este skill: **si hay un límite real, no es un medio disponible.** Una fuente prohibida no se intenta "a ver si funciona" — el sistema la trata como inexistente. No es un freno añadido al final; es parte de la definición misma de qué cuenta como fuente. Esto te ahorra trabajo y protege al cliente: no gastas esfuerzo en fuentes cerradas ni expones al cliente a obtener datos que no debía.

El filtro de "permitido" nunca se relaja por conveniencia. Que un dato sea valioso, que el cliente lo pida con urgencia, o que "todo el mundo lo scrapea" no convierte una fuente prohibida en disponible. Ante la duda sobre si algo está permitido, trátalo como dudoso y escálalo, no lo asumas permitido.

## El perímetro se expande con lo que el cliente aporta

El conjunto de fuentes disponibles no es fijo — depende de qué trae el cliente. Esto es el modelo BYO (bring-your-own) aplicado a fuentes:

Una fuente que es `condicional` (requiere una credencial, una API key, un acceso autenticado) **se vuelve disponible para ese cliente** en cuanto él aporta la credencial legítima que la abre. La misma fuente está cerrada para un cliente sin la credencial y abierta para uno que la tiene. El sistema sirve a clientes distintos con perímetros distintos según lo que cada uno aporta legítimamente.

La palabra clave es *legítima*: la credencial tiene que ser del cliente o estar autorizado a usarla. Si el cliente "consigue" una credencial que no le pertenece, esa fuente sigue prohibida — BYO expande el perímetro con accesos propios, no con accesos robados.

## Cómo resuelves cada candidata

Por cada fuente en `fuentes_candidatas`, la ficha ya trae una marca de acceso (`obvio`, `condicional`, `dudoso`) que el intake estimó. Tú la confirmas o la corriges con un análisis real, y la resuelves a uno de cuatro estados:

- **disponible**: accesible y permitida ahora mismo, sin requerir nada del cliente. APIs públicas documentadas, datasets abiertos, feeds RSS, páginas sin restricción aplicable. Entra al plan directamente.
- **condicional**: permitida pero no accesible sin algo que el cliente debe aportar — una API key, credenciales de una cuenta suya, un archivo que tiene derecho a subir. Entra al plan *pendiente de credencial*.
- **descartada**: no permitida, o inaccesible sin violar un límite. Prohibida por ToS, tras login ajeno, paywall, datos personales sin base legal. No entra al plan. Se registra por qué.
- **dudosa**: no pudiste determinar con confianza si es permitida o accesible. No la asumes en ningún sentido — la marcas para revisión y, si el riesgo de equivocarte es alto, la tratas como descartada hasta confirmar.

### El análisis de "permitido", en concreto

Para decidir si una fuente es permitida, razonas sobre su naturaleza, no sobre si técnicamente responde:

- ¿El acceso requiere autenticación que no es del cliente? → no permitida.
- ¿Los términos de servicio prohíben la extracción? → no permitida. El ToS y el marco legal aplicable son la autoridad sobre el permiso.
- ¿Qué dice robots.txt? → es una **señal técnica** de la intención del sitio sobre el rastreo automatizado, no la autoridad legal. Un `Disallow` es una señal fuerte de restricción que conviene respetar; su ausencia *no* equivale a permiso legal si el ToS dice lo contrario. Robots.txt informa el juicio, no lo reemplaza: una fuente puede estar permitida por robots.txt pero prohibida por ToS, o al revés. Pesa ambos, y cuando entran en conflicto, el ToS y la ley mandan sobre el archivo técnico.
- ¿El dato es personal (identifica a una persona) y no hay base legal para tratarlo? → no permitida sin esa base. Especialmente sensible bajo marcos como la LFPDPPP en México.
- ¿Es contenido tras un paywall? → no permitida sin suscripción legítima del cliente (en cuyo caso es condicional, no disponible).
- ¿Es una fuente que incita odio, viola privacidad, o facilita daño? → descartada sin excepción, aunque sea técnicamente accesible.

Si ninguna de estas condiciones bloquea, y el dato es público u obtenible con medios legítimos, es permitida.

### El riesgo de cada fuente, como señal para el gate

Por cada fuente, además del estado, estimas un `riesgo_fuente` (`bajo | medio | alto | critico`) — qué tan delicada es legal o éticamente, aunque sea permitida. Una API pública de clima es riesgo bajo; una fuente con datos personales aunque haya base legal es riesgo más alto; raspar contenido en una zona gris jurisdiccional es alto. Igual que en el intake: tú *estimas* el riesgo, no eres la autoridad. Es una señal que viaja al gate de aprobación para que el control humano mire con más cuidado las fuentes delicadas antes de operar. Ante la duda, sube el nivel. Una fuente disponible pero de riesgo alto/crítico debe llegar marcada al gate, no pasar como si fuera trivial.

## El plan de fuentes que produces

Tu salida es un objeto estructurado, no prosa, porque el skill de extracción que sigue lo ejecuta. Por cada candidata resuelta:

```
{
  "id": "identificador estable y único de esta fuente (p.ej. src-1)",
  "fuente": "nombre de la fuente",
  "estado": "disponible | condicional | descartada | dudosa",
  "metodo_acceso": "api | feed | web | archivo_cliente | dataset_abierto | null",
  "datos_que_cubre": ["qué datos_requeridos de la ficha aporta esta fuente"],
  "requiere_del_cliente": "qué credencial o aporte necesita (null si disponible)",
  "riesgo_fuente": "bajo | medio | alto | critico",
  "razon": "por qué quedó en ese estado",
  "nota_permiso": "base de por qué es permitida, o por qué no lo es",
  "metadatos": { "...datos de acceso que el extractor necesita..." }
}
```

Dos campos son el contrato con el extractor y no son opcionales para fuentes usables:

- **`id`**: un identificador estable y único por fuente (p.ej. `src-1`, `src-2`). El extractor lo usa como llave para mapear credenciales BYO y para la trazabilidad del audit log. No uses el nombre como identificador —los nombres pueden repetirse o cambiar— por eso el `id` es separado y estable.
- **`metadatos`**: los datos de acceso que el adaptador de extracción necesita para llegar a la fuente. **Qué va aquí depende del `metodo_acceso`**, y sin esto el extractor sabe que la fuente es usable pero no de dónde sacar los datos:
  - `feed` → `{ "url": "..." }` (la URL del feed RSS/Atom)
  - `web` → `{ "url": "..." }` (la URL de la página)
  - `api` → `{ "endpoint": "...", "auth": {...}, "items_path": "...", "campos_contenido": [...] }` (endpoint y, si es condicional, cómo se inyecta la credencial)
  - `archivo_cliente` → `{ "ruta": "..." }` (la ruta del archivo que el cliente aportó)
  - `dataset_abierto` → `{ "url": "...", "formato": "csv|json", "delimiter": "...", "items_path": "..." }`

  Para fuentes `descartada` o `dudosa`, `metadatos` puede ir vacío `{}` — no se van a extraer. Para `disponible` y `condicional`, debe traer lo que su `metodo_acceso` requiere, o el extractor no podrá obtener los datos.

Y tres bloques de resumen y verificación:

```
"datos_requeridos": ["copia literal de los datos_requeridos de la ficha de intake"],
"resumen": {
  "fuentes_disponibles": N,
  "fuentes_condicionales": N,
  "fuentes_descartadas": N,
  "fuentes_dudosas": N
},
"cobertura_datos": {
  "completa": true | false,
  "datos_sin_fuente": ["datos_requeridos que ninguna fuente cubre"],
  "datos_condicionales": ["datos que solo cubren fuentes pendientes de credencial"]
}
```

Incluyes `datos_requeridos` como copia literal de la ficha porque hace al plan **autovalidante**: el validador no tiene que confiar en que calculaste bien la cobertura — la recalcula desde `datos_requeridos` y la compara contra lo que declaraste. Si te equivocaste al marcar `completa` o al listar `datos_sin_fuente`, el código lo atrapa. Copia los datos requeridos exactamente como vienen en la ficha; no los reformules, o la comparación fallará.

El bloque `cobertura_datos` es lo que el extractor necesita para decidir si puede correr **completo** (todos los datos cubiertos por fuentes disponibles), **parcial** (algunos datos sin fuente), o **esperar credenciales** (datos que solo cubren condicionales). `completa` es true solo si todos los `datos_requeridos` de la ficha tienen al menos una fuente disponible que los cubra — las condicionales pendientes no cuentan como cobertura completa hasta que el cliente aporte su credencial. Si un dato requerido no lo cubre ninguna fuente, va a `datos_sin_fuente`, y eso es información valiosa: quizá el objetivo no es alcanzable con fuentes legítimas.

## Qué reportas al cliente y qué haces en silencio

Configurable por cliente; el default razonable: las `condicional` se reportan solo si su dato no está ya cubierto por una disponible (no pidas credenciales que no hacen falta). Las `descartada` se reportan breve y honesto — "esta fuente existe pero no es usable legítimamente porque [razón]" — sin tono de excusa. Las `dudosa` se reportan siempre, requieren decisión humana. Las `disponible` entran al plan en silencio.

Nunca le dices al cliente cómo saltarse un límite de una fuente descartada. Si pregunta "¿y cómo accedo a esa entonces?", la respuesta es la vía legítima (conseguir la credencial propia, pedir autorización) o nada.

## Validación determinista antes de emitir

Antes de entregar el plan, córrelo por `scripts/validar_plan.py`, que verifica de forma determinista: cada fuente tiene estado y riesgo válidos, las `condicional` declaran qué requieren, las `descartada`/`dudosa` declaran razón, los métodos de acceso son válidos, el resumen cuadra con el detalle, y `cobertura_datos` es coherente con los estados. Si rechaza el plan, corrige y revalida.

## Qué despachas al terminar

Si `cobertura_datos.completa` es true, despachas al skill de extracción con el plan como variables base. Si es false pero hay condicionales que completarían la cobertura, despachas a la solicitud de credenciales y esperas — solo cuando hace falta, no si las disponibles ya bastan. Si no hay forma de cubrir los datos ni con credenciales, reportas que el objetivo no es alcanzable con fuentes legítimas y por qué, devolviendo el control.

## Señales de que lo hiciste bien

- Ninguna fuente descartada se "coló" al plan por ser valiosa o urgente.
- No pediste credenciales cuando las fuentes disponibles ya cubrían el dato.
- Distinguiste "inaccesible" (técnico) de "no permitido" (límite) — razones distintas de descarte.
- Trataste robots.txt como señal, no como autoridad única; el ToS pesó más cuando hubo conflicto.
- `cobertura_datos` dice con precisión qué datos quedan sin cubrir y cuáles dependen de credenciales.
- `datos_requeridos` viaja en el plan como copia literal de la ficha, para que la cobertura sea verificable.
- Las fuentes descartadas/dudosas no contaron para la cobertura, aunque tuvieran datos_que_cubre.
- Las fuentes delicadas llegaron al gate marcadas con su `riesgo_fuente`.

## Señales de que algo va mal

- Marcaste una fuente como disponible "porque técnicamente el scraper puede leerla", ignorando el ToS.
- Asumiste permitida una fuente dudosa para no frenar el plan.
- Declaraste `cobertura_datos.completa: true` contando fuentes condicionales aún sin credencial.
- Pediste credenciales para un dato que una fuente disponible ya cubría.
- Trataste una credencial ajena como si expandiera legítimamente el perímetro.
