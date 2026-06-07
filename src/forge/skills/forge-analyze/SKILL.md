---
name: forge-analyze
description: >-
  Toma los registros normalizados de forge-extract y la ficha de forge-intake, y produce el ENCARGO DE FABRICACIÓN que alimenta a la FACTORY — la especificación de qué capacidad (skill) resuelve el problema del cliente. Es el puente entre el scraper y la FACTORY. Decide entre tres caminos: reusar un skill aprobado tal cual, modificar/extender uno existente, o fabricar uno nuevo. Actívalo después de forge-extract, cuando hay datos extraídos listos para convertirse en una capacidad, o cuando el problema pide "qué se puede hacer con estos datos", "construir la solución", "generar el skill". NO entrega un resultado al cliente (la entrega final la hace la capacidad que la FACTORY fabrica, una vez aprobada y operando) ni ejecuta la solución. Su trabajo es convertir datos en una especificación accionable para la FACTORY.
forge_vertical: universal
forge_autonomy: semi
forge_output_format: text
forge_approved: false
forge_version: 1.0
forge_pipeline_steps: 1
forge_command: /forge forge-analyze
forge_author: ""
forge_created: ""
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
    purpose: validación determinista de la coherencia del encargo de fabricación antes de emitirlo
forge_mcp_servers:
  required:
    - server: mcp_code
      resource: code_execution.python
      reason: "Ejecuta validar_encargo.py — sin validación determinista el encargo puede salir incoherente y la FACTORY fabricaría sobre especificación malformada."
  degradable: []
  optional: []
mcp_compatibility:
  engine_version_minimum: "3.1"
  tested_servers:
    - mcp_code
  known_incompatibilities: []
agentic:
  can_run_unattended: false
  next_pipeline: factory
  on_completion: chain
dynamic_flow:
  branches:
    - condition: "encargo.decision == 'reusar'"
      action: jump_to
      target: parametrizar_skill_existente
    - condition: "encargo.decision == 'modificar'"
      action: jump_to
      target: factory_modificacion
    - condition: "encargo.decision == 'fabricar'"
      action: jump_to
      target: factory_fabricacion
---

# Forge Analyze — el puente entre el scraper y la FACTORY

Recibes los registros que `forge-extract` normalizó y la ficha que `forge-intake` produjo. Tu trabajo es convertir esos datos en un **encargo de fabricación**: la especificación de qué capacidad resuelve el problema del cliente, lista para que la FACTORY la ejecute. No entregas nada al cliente — entregas hacia adentro del sistema. La capacidad que la FACTORY fabrica, una vez aprobada y operando, es la que entregará al cliente.

Eres el eslabón que cierra el lazo: datos crudos del mundo → entendimiento → especificación de qué construir. Antes de ti, el sistema sabía *qué se necesita* (la ficha) y tenía *los datos* (la extracción). Después de ti, el sistema sabe *qué capacidad fabricar* para resolverlo.

## El acto central: decidir entre tres caminos

No todo problema necesita un skill nuevo. Fabricar de cero por cada problema multiplica la superficie de error y produce variantes casi-iguales que nadie auditó — la deriva de skills. Por eso tu primera responsabilidad es **verificar si ya existe capacidad que sirva**, y solo fabricar cuando de verdad no hay nada. Tres caminos:

### reusar — un skill aprobado ya cubre la tarea
Existe un skill aprobado cuyo *verbo central es la tarea*, y para este problema solo cambian los parámetros. No se toca el skill; se parametriza con los datos nuevos. Es el camino más barato y más seguro: capacidad ya auditada, reusada. El skill sigue aprobado (no cambia su comportamiento).

### modificar — un skill aprobado cubre casi, necesita ajustes
Existe un skill cuyo verbo central es la tarea, pero le falta cubrir una variante, un formato, o un caso que este problema requiere. El encargo a la FACTORY no es "fabrica de cero" — es "toma este skill y extiéndelo así". Modificar (ampliar el rango de un skill aprobado) es preferible a clonar uno nuevo casi-igual, porque mantiene un canónico que mejora en vez de multiplicar variantes.

Consecuencia de gobernanza no negociable: **modificar un skill aprobado cambia su comportamiento auditado, así que vuelve a `forge_approved: false`.** Una modificación es una nueva versión que necesita su propia aprobación. Nunca dejes un skill modificado aprobado por herencia — eso metería comportamiento no auditado en producción. `reaprobacion_requerida: true`, siempre, al modificar.

### fabricar — ningún skill se acerca
Ningún skill aprobado tiene un verbo central cercano a la tarea. La FACTORY fabrica desde cero. Todo skill nuevo nace `forge_approved: false`: `reaprobacion_requerida: true`.

## Cómo verificas si un skill cumple la tarea

La verificación es el corazón de la decisión, y se hace por **verbo central**, no por nombre ni por keywords. El verbo central es lo que el skill realmente *hace*. Un skill llamado "analizador-sentimiento" no sirve para "clasificar tópicos" aunque ambos suenen a "análisis de texto" — sus verbos centrales son distintos. Comparar nombres engaña; comparar lo que hace el skill, no.

El criterio, en orden:

1. **¿Hay un skill aprobado cuyo verbo central ES la tarea y solo cambian parámetros?** → reusar.
2. **¿Hay uno cuyo verbo central es la tarea pero le falta una variante/formato/caso que este problema necesita?** → modificar, listando qué ajustes (derivados de los datos) hacen falta.
3. **¿Ninguno tiene un verbo central cercano?** → fabricar.

Ante la duda entre modificar y fabricar, inclínate a modificar si hay un canónico razonablemente cercano — mantener un skill que mejora es mejor que sembrar variantes. Pero si modificar distorsionaría el verbo central del skill existente (volverlo dos cosas a la vez), fabrica uno nuevo: un skill con un verbo central confuso es peor que dos skills claros.

## La especificación para la FACTORY

Cuando el camino es `modificar` o `fabricar`, el encargo trae las cinco variables que la FACTORY necesita (según su método de fabricación), ya derivadas de los datos reales en vez de adivinadas:

- **verbo_central**: la acción principal que el skill habilita, en una frase. Derivado del `objetivo` de la ficha y de lo que los datos revelaron.
- **señal_disparo**: qué frases/contextos activan el skill (para su `description`). Derivado del tipo de problema.
- **formato_salida**: qué produce el skill (texto, docx, alerta, etc.). Del `entregable` de la ficha.
- **complejidad**: ¿solo SKILL.md, o necesita scripts/references/assets? Inferido de si la tarea tiene partes deterministas (que irían a scripts) — usa el eje mecánico/con-juicio de los `pasos` de la ficha.
- **distincion**: de qué skills adyacentes hay que distinguirlo, para que su `description` no se solape con otros y dispare cuando debe.

Estas cinco salen de cruzar la ficha con los datos. Cuanto más concretas, mejor el skill que la FACTORY fabrica al primer intento — ese es el punto de calidad del encargo.

## Honestidad sobre datos incompletos

Si `forge-extract` entregó cobertura parcial (su `resumen_extraccion.extraccion_completa` era false, o hubo `datos_sin_extraer`), el encargo debe declararlo: `basado_en_datos_completos: false` y qué faltó. Un encargo formulado sobre datos incompletos puede producir una capacidad que no cubre todo el problema — y quien apruebe debe saberlo. Nunca formules un encargo como si tuvieras datos completos cuando no los tienes.

## El riesgo acumulado viaja al gate

El encargo lleva el riesgo acumulado de toda la cadena: el `riesgo_operativo` que estimó el intake, el `riesgo_fuente` más alto de las fuentes que usó sources, y si la extracción levantó `requiere_revision_humana`. No eres la autoridad sobre el riesgo —el gate lo es— pero consolidas la señal para que el gate la vea en un solo lugar. Si el riesgo acumulado es alto o crítico, el encargo lo marca para revisión humana antes de aprobar la capacidad fabricada.

## El encargo de fabricación que produces

```
{
  "decision": "reusar | modificar | fabricar",
  "skill_objetivo": "nombre del skill a reusar/modificar (null si fabricar)",
  "justificacion": "por qué este camino, comparando verbos centrales",
  "modificaciones": ["si modificar: qué ajustes necesita, derivados de los datos"],
  "especificacion_factory": {
    "verbo_central": "...",
    "señal_disparo": "...",
    "formato_salida": "...",
    "complejidad": "...",
    "distincion": "..."
  },
  "parametros": { "si reusar: con qué parámetros se invoca el skill existente" },
  "evidencia_usada": [
    {
      "registro_id": "id del registro del extractor que sustenta esto",
      "fuente": "id de la fuente de donde vino",
      "razon": "por qué este dato justifica la especificación"
    }
  ],
  "nivel_generalizacion": "cliente | vertical | universal",
  "basado_en_datos_completos": true | false,
  "datos_faltantes": ["qué no se pudo extraer, si aplica"],
  "riesgo_acumulado": { "nivel": "bajo|medio|alto|critico", "fuentes_del_riesgo": [...] },
  "reaprobacion_requerida": true | false,
  "requiere_revision_humana": true | false
}
```

`especificacion_factory` va vacía o null si `decision` es `reusar` (no se fabrica nada). `parametros` solo aplica si `reusar`. Las reglas duras: si `fabricar`, `skill_objetivo` es null; si `modificar` o `fabricar`, `reaprobacion_requerida` es true sin excepción.

## La evidencia: trazabilidad causal, no solo conclusión

`evidencia_usada` es lo que convierte el encargo de una opinión en una decisión rastreable. La FACTORY no debe recibir solo "fabrica esto" — debe recibir "fabrica esto *porque* estos datos concretos lo muestran". Cada entrada enlaza un registro del extractor (por su `registro_id`) y su fuente (por el `id` que sources asignó) con la razón de por qué ese dato justifica una parte de la especificación.

Esto cierra la cadena causal completa: si la capacidad fabricada resulta mal, se puede rastrear hasta el dato que la motivó — no solo por estructura (ficha→plan→extracción→encargo) sino por evidencia (este registro específico pidió esta capacidad). Usa los ids que ya viajan por la cadena: el `registro_id` que el extractor sella y el `id` de fuente que sources asigna. No inventes evidencia: si una parte de la especificación no se apoya en un dato extraído concreto, dilo en la justificación en vez de fabricar una referencia.

## El nivel de generalización: dónde vive el skill y con qué rigor se aprueba

`nivel_generalizacion` define el alcance del skill fabricado, y es central para el modelo horizontal:

- **cliente**: el skill resuelve algo específico de *este* cliente; no se reusa fuera. Menor alcance de riesgo — si falla, afecta a un cliente.
- **vertical**: reusable dentro de una industria o tipo de cliente (docentes, abogados, terapeutas). Alcance medio.
- **universal**: reusable por cualquier dominio. Mayor alcance — y mayor riesgo: un skill universal mal hecho contamina todo el ecosistema, no a un cliente.

Dos consecuencias. Primera, de gobernanza: **cuanto más amplio el nivel, más rigor de aprobación.** Un skill `universal` debería inclinarse a `requiere_revision_humana: true` aunque su riesgo operativo parezca bajo, porque su radio de impacto es todo el sistema. Segunda, anti-inflación: **fabrica al nivel más específico que resuelve el problema.** La tentación de marcar todo `universal` para reusarlo más multiplica skills universales mediocres — la misma deriva que evitamos al preferir modificar sobre clonar. Se empieza específico (cliente o vertical) y se generaliza *después*, solo si aparece demanda real de otro dominio. Empezar universal es optimización prematura.

## Validación determinista antes de emitir

Antes de emitir el encargo, córrelo por `scripts/validar_encargo.py`, que verifica la coherencia: que la decisión sea válida; que `fabricar` tenga `skill_objetivo` null; que `modificar` tenga `skill_objetivo` y `modificaciones`; que `reusar` no traiga `especificacion_factory`; que `modificar`/`fabricar` tengan `reaprobacion_requerida: true`; que las cinco variables estén presentes cuando se fabrica o modifica; y que si el riesgo acumulado es alto/crítico, `requiere_revision_humana` sea true. Si rechaza, corrige y revalida.

## Qué despachas al terminar

Según `decision`: `reusar` despacha a parametrizar el skill existente; `modificar` y `fabricar` despachan a la FACTORY con la especificación. En todos los casos, la capacidad resultante (modificada o nueva) cruza el gate de aprobación antes de operar — `forge_approved: false` hasta entonces.

## Señales de que lo hiciste bien

- Comparaste verbos centrales, no nombres, al verificar si un skill cumple.
- Preferiste modificar un canónico cercano sobre clonar una variante casi-igual.
- Cada modificación o fabricación quedó marcada `reaprobacion_requerida: true`.
- Las cinco variables de la FACTORY salieron de los datos reales, no de suposiciones.
- Cada parte de la especificación se enlazó a la evidencia concreta que la justifica.
- Fabricaste al nivel más específico que resuelve el problema, sin inflar a universal.
- Declaraste honestamente si el encargo se basó en datos incompletos.
- El riesgo acumulado de toda la cadena llegó consolidado al gate.

## Señales de que algo va mal

- Decidiste fabricar sin verificar si un skill existente servía.
- Reusaste un skill por nombre parecido aunque su verbo central no era la tarea.
- Modificaste un skill y lo dejaste aprobado por herencia.
- Inventaste evidencia para una parte de la especificación que no se apoyaba en datos reales.
- Marcaste un skill como universal cuando solo resolvía un caso de un cliente.
- Formulaste el encargo como si tuvieras datos completos cuando la extracción fue parcial.
- Distorsionaste el verbo central de un skill al modificarlo, volviéndolo dos cosas a la vez.
