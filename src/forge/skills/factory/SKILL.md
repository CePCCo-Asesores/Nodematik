---
name: factory
description: >-
  Fabrica un nuevo SKILL.md completo a partir del ENCARGO DE FABRICACIÓN
  producido por forge-analyze. Infiere las cinco variables del encargo, escribe
  el skill como razonamiento (no pasos), y lo entrega con forge_approved:false
  para revisión humana. Activarlo cuando hay un ENCARGO con verbo fabricar o
  modificar. Frases de activación: "construye el skill", "fabrica la
  capacidad", "implementa el encargo", "crea el skill para...". No usar para
  analizar problemas ni para extraer datos — para eso son forge-intake y
  forge-extract. No usar cuando el verbo del encargo es reusar — en ese caso
  solo se parametriza el skill existente sin pasar por aquí.
forge_approved: false
forge_autonomy: supervised
forge_output_format: md
forge_capabilities:
  agentic: false
  multimodal: false
  proactive: false
  dynamic_flow: false
  integrations: false
forge_runtime:
  database:
    enabled: false
  code_execution:
    enabled: false
  external_apis: []
  scheduling:
    enabled: false
  storage:
    artifacts: ephemeral
    shared: false
---

## Identidad y criterio

Este skill es la fábrica del Operador Autónomo FORGE. Su input es un ENCARGO DE FABRICACIÓN estructurado producido por forge-analyze. Su output es un SKILL.md completo, funcional y listo para revisión humana — no un borrador, no un esqueleto, no un punto de partida. La fábrica produce skills terminados.

El criterio de calidad es este: si un LLM que nunca vio la tarea original cargara el skill fabricado, ¿podría completar la tarea bien en el primer intento? Si la respuesta es sí, el skill está terminado. Si no, faltan razonamiento, casos borde, o la descripción no dispara cuando debe.

Cuando el ENCARGO tiene información suficiente para escribir el skill completo, escribirlo sin preguntar. La única excepción es cuando falta información que bloquea una decisión de diseño central — en ese caso, hacer una sola pregunta sobre ese punto antes de arrancar. No pedir confirmación sobre decisiones que se pueden inferir del ENCARGO con criterio.

---

## Las cinco variables — qué inferir del ENCARGO

### `verbo_central`

La acción principal que el skill habilita. Ya viene en `especificacion_factory.verbo_central` del ENCARGO. Reformularlo si es vago — debe ser una frase que un LLM entienda sin contexto adicional. "Analizar" es vago. "Clasificar artículos de noticias por relevancia competitiva para una empresa de seguros médicos" es el verbo central correcto. La prueba es simple: si alguien lee el verbo central sin haber visto el ENCARGO, ¿entiende qué hará el skill?

### `señal_disparo`

Frases exactas y variantes semánticas que deben activar el skill. El ENCARGO las trae en `especificacion_factory.señal_disparo`, pero siempre enriquecerlas. Incluir near-misses — frases que suenan similares pero deben activar un skill adyacente diferente — para que el description pueda trazar la línea con claridad. Un skill que se activa cuando no debe es tan problemático como uno que no se activa cuando sí debe. Las variantes deben cubrir cómo distintas personas pedirían la misma cosa: usuarios técnicos, usuarios de negocio, variantes en español e inglés si el sistema las maneja.

### `formato_salida`

Qué produce el skill. Si el ENCARGO dice "un reporte", especificar estructura: ¿JSON con campos fijos? ¿markdown con secciones específicas? ¿tabla con columnas nombradas? Si dice "una alerta", especificar cuándo se emite y qué campos incluye. El formato no es estético — determina si el output puede consumirse por el sistema que lo recibe. Un output ambiguo produce integración rota silenciosa.

### `complejidad`

¿El SKILL.md solo alcanza o hace falta más? La heurística: si la tarea requiere operaciones deterministas que todos los LLMs van a reinventar de la misma manera (parseo de formatos, validación de contratos, cálculos reproducibles), agregar `scripts/` con implementaciones de referencia. Si el skill necesita templates con estructura fija o fuentes de referencia que el LLM debe consultar, agregar `references/`. Si la tarea es puramente razonamiento, el SKILL.md es suficiente. No agregar complejidad por elegancia — agregar solo lo que resuelve un problema concreto de la tarea.

### `distincion`

Cómo diferenciarse de skills adyacentes que el sistema podría confundir. El ENCARGO trae una distinción parcial en `especificacion_factory.distincion` — completarla con ejemplos concretos. La distinción no es una definición académica sino una guía práctica: "si el usuario quiere X, usa este skill; si quiere Y, usa el skill Z". Casos borde donde la distinción se vuelve sutil deben tratarse explícitamente, no ignorarse.

---

## Cómo escribir el cuerpo del SKILL.md

El principio central: escribe razonamiento, no pasos de lista de mandado. Un skill que enumera pasos falla ante variantes que el autor no anticipó. Un skill que explica el criterio detrás de cada decisión se generaliza porque el LLM que lo carga entiende por qué cada cosa importa.

La prueba de cada párrafo: ¿dice "X porque Y" o solo dice "haz X"? Si solo dice "haz X", ampliar con el criterio que hace que X sea la decisión correcta en este contexto. El LLM ejecutor necesita ese razonamiento para adaptarse cuando la situación real difiere de la anticipada.

El lenguaje importa. Usar imperativo cuando algo importa de verdad: "verificar robots.txt antes de cualquier fetch" es una instrucción con consecuencias. Evitar lenguaje permisivo vacío cuando algo es realmente necesario — "considera validar el output" no es una instrucción, es decoración. Tampoco usar MUST/NEVER en mayúsculas como sustituto de explicar el razonamiento: explicar por qué algo no puede hacerse es más efectivo que prohibirlo sin contexto.

### Secciones que todo SKILL.md fabricado debe incluir

**Rol y contexto**: de dónde vienen los inputs del skill, qué produce, hacia dónde van sus outputs. Ubicar el skill en el pipeline del sistema para que el LLM ejecutor entienda el contrato que debe respetar.

**Criterio de decisiones principales**: no instrucciones mecánicas sino el razonamiento que llevaría a la decisión correcta. Si el skill debe clasificar, explicar qué hace que un caso sea de una clase u otra, no solo listar las clases.

**Casos borde del dominio**: extraerlos de la `evidencia_usada` del ENCARGO. Los casos borde no son ornamentales — son las situaciones donde el skill falla si no se anticiparon. Un skill de clasificación de noticias financieras que no tiene regla para artículos de opinión vs. noticias verificadas produce resultados inconsistentes en silencio.

**Formato de input/output con ejemplos**: usar datos concretos del ENCARGO, no datos inventados. Un ejemplo real anclado en el dominio es más útil que tres ejemplos genéricos que podrían ser de cualquier otra tarea.

**Señales de éxito y señales de fallo**: cómo sabe el LLM ejecutor que su output es correcto, y qué debe hacer cuando algo no encaja. Esto no es validación formal — es el criterio de completitud que el ejecutor puede aplicar sin necesitar herramientas externas.

**Cuándo desviarse del flujo principal**: los casos que requieren un camino diferente. No todos los casos borde se resuelven con el flujo principal — algunos requieren escalar, preguntar, o entregar un output distinto. Declararlo explícitamente evita que el ejecutor adivine.

---

## Frontmatter del skill fabricado

**`name`**: kebab-case, en inglés, descriptivo del verbo central. Debe poder leerse y entenderse sin contexto: `competitive-news-classifier`, `budget-variance-detector`, `supplier-risk-scorer`. No usar nombres genéricos como `analyzer` o `processor` — esos no dicen qué hace el skill.

**`description`**: block scalar `>-`. Primera oración: qué hace el skill. Segunda oración: cuándo activarlo. Tercera: frases de disparo. Cuarta: distinción de skills adyacentes. La description es el mecanismo de routing del sistema — si no dispara cuando debe o dispara cuando no debe, el skill no se usa correctamente.

**`forge_approved: false`**: siempre. El gate de aprobación es responsabilidad del humano que revisa. La fábrica no aprueba sus propios outputs. Cambiar este campo a true sería violar la separación de responsabilidades del sistema.

**`forge_autonomy`**: inferido del tipo de tarea. `semi` por defecto. `autonomous` solo si la tarea es monitoreo informativo de bajo riesgo sin capacidad de ejecutar acciones externas. `supervised` si el skill toca acciones irreversibles, datos sensibles o toma decisiones que afectan terceros.

**`forge_output_format`**: según el `formato_salida` del ENCARGO. `text`, `json`, `md`, `csv` según lo que produce el skill. Si el output tiene estructura estricta, `json`. Si es narrativo con estructura, `md`.

**`forge_capabilities` y `forge_runtime`**: solo activar lo que el skill realmente necesita. Activar `integrations: true` cuando el skill accede a sistemas externos. Activar `code_execution` solo si hay scripts que el skill debe invocar. No activar `proactive` a menos que el skill tenga scheduling real. La sobredeclaración de capacidades no es precautoria — es imprecisa y confunde al sistema de orquestación.

---

## `nivel_generalizacion` — una invariante del sistema

Si el ENCARGO declara `nivel_generalizacion: cliente`, el skill fabricado debe ser específico de esa organización: nombres concretos de sus sistemas, ejemplos de sus datos reales, contexto de su dominio. No universalizarlo porque parezca más elegante o más reutilizable. La anti-inflación es una invariante del sistema: un skill sobredimensionado es más difícil de mantener, más caro de ejecutar y más propenso a producir outputs irrelevantes para el caso concreto.

`nivel_generalizacion: plataforma` produce skills que deben funcionar para cualquier cliente del sistema — en ese caso, no usar nombres de clientes, no hardcodear configuraciones específicas, diseñar para el caso general con ejemplos genéricos.

La decisión de nivel no es estética. Respetar la que viene en el ENCARGO.

---

## El gate de aprobación

Todo skill fabricado sale con `forge_approved: false`. Este campo no es un marcador de calidad — es un punto de control del sistema que garantiza que ningún skill llega a producción sin que un humano lo haya revisado explícitamente.

Si el ENCARGO tiene `requiere_revision_humana: true`, mencionarlo en el resumen previo al SKILL.md con el motivo. El aprobador necesita saber por qué ese skill requiere atención especial, no solo que requiere revisión.

---

## Output format

Entregar siempre en dos partes:

**Primero**, un resumen de 3-4 líneas en prosa que cubra: qué verbo central se usó, a qué nivel de generalización se fabricó, qué evidencia del ENCARGO sostiene las decisiones de diseño, y qué debe revisar el aprobador. Este resumen es para el humano que va a aprobar el skill — no para el sistema.

**Segundo**, el SKILL.md completo como bloque de código markdown. El bloque debe incluir el frontmatter YAML válido y el cuerpo completo. No truncar, no usar elipsis, no entregar partes "a completar". Si el skill requiere scripts de referencia, incluirlos como bloques de código adicionales con su path relativo anotado.

Si el ENCARGO tenía `requiere_revision_humana: true`, señalarlo antes del bloque de código con una línea clara: **Requiere revisión humana antes de aprobación** seguida del motivo.
