---
name: forge-intake
description: >-
  Convierte un problema en lenguaje natural en una FICHA estructurada de 11
  campos que define el objetivo, los datos requeridos, las fuentes candidatas,
  el eje temporal, el entregable, los pasos, el tipo de acción, el riesgo
  operativo, la suficiencia y el skill destino sugerido. Activarlo ante
  cualquier solicitud de análisis, diagnóstico, monitoreo, vigilancia,
  investigación o automatización expresada en lenguaje cotidiano. Frases de
  activación: "quiero saber si...", "necesito entender...", "analiza...",
  "monitorea...", "dame un diagnóstico de...", "¿cómo está...?",
  "detecta cuando...", "avísame si...". No usar cuando ya hay datos
  disponibles y se necesita decidir qué skill construir — para eso es
  forge-analyze.
forge_approved: false
forge_autonomy: semi
forge_output_format: text
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
    enabled: true
    language: python
    purpose: >-
      validar_ficha.py verifica coherencia de los 11 campos de la FICHA
      y determina si requiere revisión humana
  external_apis: []
  scheduling:
    enabled: false
  storage:
    artifacts: ephemeral
    shared: false
---

## Rol y contexto

Este skill es el primer paso del Operador Autónomo FORGE. Su trabajo no es resolver el problema sino entenderlo con suficiente precisión como para que los pasos siguientes puedan ejecutarse sin ambigüedad. El output de forge-intake es la FICHA — un contrato estructurado de 11 campos que define qué se quiere, qué se necesita para lograrlo, y quién o qué lo resolverá. Si la FICHA está mal, todo lo que viene después está construido sobre una base falsa. Una corrección en este paso cuesta minutos. Una corrección en forge-execute puede costar horas o invalidar trabajo ya realizado.

La FICHA no es un resumen del input del usuario. Es una traducción del problema a términos operativos, realizada con criterio, no con transcripción. El usuario puede decir "quiero entender cómo está mi competencia" — la FICHA debe traducir eso a un objetivo concreto, no repetir la frase.

---

## La FICHA — los 11 campos y el criterio detrás de cada uno

### `objetivo`

Una frase. El resultado concreto que se busca, no el proceso que lleva a él. La prueba de un buen objetivo es que permite saber cuándo está terminado: si el objetivo dice "detectar oportunidades de expansión en el mercado peruano", es posible saber cuándo se encontró algo (o cuándo no). Si dice "hacer un análisis de mercado", no hay manera de saber cuándo termina.

El objetivo no describe metodología. "Usar datos de redes sociales para evaluar la percepción de marca" es metodología, no objetivo. El objetivo sería "evaluar si la percepción de marca en redes sociales mejora o empeora semana a semana". La diferencia importa porque el objetivo define el criterio de suficiencia de todo lo que sigue.

### `datos_requeridos`

Lista de categorías de datos que el objetivo necesita para ser respondido. La heurística es: ¿qué tipo de dato, si faltara, haría imposible responder el objetivo? Eso es datos_requeridos. Lo que ayudaría pero no es indispensable, no va aquí.

Ser específico sin ser exhaustivo. No es una lista de variables sino de categorías: "precios históricos de competidores", "volumen de menciones en redes", "registros de ventas por SKU". Evitar entradas genéricas como "datos de mercado" — no dicen qué bloquea la respuesta.

### `fuentes_candidatas`

De dónde podrían venir los datos requeridos. Este campo no es el plan de extracción — eso lo resuelve forge-sources. Aquí solo se nombran candidatos con suficiente precisión para que un skill posterior sepa dónde buscar: "Compranet", "Google Trends API", "base interna CRM", "scraping de sitio web del competidor". Si la fuente no está clara, declararlo como incertidumbre, no inventar.

### `eje_temporal`

Objeto con dos subfields: `tipo` y, si aplica, `ritmo`.

El `tipo` es 'unico' o 'continuo'. Un análisis puntual, un diagnóstico que se hace una vez, una investigación con fecha de entrega — todos son 'unico'. Vigilancia, monitoreo, alertas, "mantenerse informado", "saber cuando cambie algo" — todos son 'continuo'.

El `ritmo` solo existe si el tipo es 'continuo', y describe la frecuencia de ejecución: "diario", "semanal", "cada 6h", "mensual". Cuando el ritmo no está declarado pero la intención es claramente continua, esta es la única pregunta permitida en modo semi antes de completar la FICHA. No asumir el ritmo — el impacto en recursos y costos es demasiado significativo para suponerlo.

La decisión eje_temporal es la más importante de la FICHA porque determina si el sistema necesita capacidad de scheduling, qué complejidad operativa implica, y qué clase de entregable tiene sentido. Una FICHA con eje_temporal incorrecto produce un plan de ejecución completamente equivocado.

### `entregable`

Qué formato tiene el output cuando el proceso termine o cuando se ejecute un ciclo. Un informe en texto, una tabla estructurada, una alerta tipo push, un dashboard actualizable, un archivo CSV, un JSON para consumo por otro sistema. El entregable debe ser coherente con el eje_temporal: si el tipo es continuo, el entregable probablemente es una alerta o un update incremental, no un informe completo en cada ciclo.

### `pasos`

Lista de pasos del proceso requerido, donde cada paso está clasificado como 'mecanico' o 'con-juicio'. Los pasos mecánicos son deterministas — ejecutan una regla, una extracción, una transformación sin necesitar razonamiento. Los pasos con juicio requieren que un LLM (o un humano) evalúe, clasifique, interprete o decida algo que no puede resolverse con una regla fija.

Esta clasificación importa porque los pasos mecánicos pueden automatizarse completamente y los de juicio pueden requerir revisión humana o un modelo más capaz. También permite estimar el costo real de ejecución.

### `tipo_de_accion`

Uno de cinco valores: 'diagnostico' (entender el estado actual de algo), 'planificacion' (diseñar cómo llegar de A a B), 'ejecucion' (hacer algo concreto en el mundo), 'monitoreo' (vigilar continuamente un estado), 'creacion_capacidad' (construir algo que no existía para poder hacer lo anterior).

El tipo de acción no es una clasificación académica — orienta qué skills son candidatos para el paso siguiente y qué nivel de autonomía es razonable. Ejecución generalmente requiere mayor validación que diagnóstico.

### `riesgo_operativo`

Objeto con tres subfields: `nivel`, `requiere_aprobacion`, `razon`.

El riesgo no es la dificultad técnica. Es el impacto si el sistema actúa con datos incorrectos, incompletos o malinterpretados. La pregunta correcta es: si el resultado de este proceso fuera erróneo, ¿cuánto daño causaría?

- `bajo`: el output es informativo, no activa ninguna acción automática, un error produce pérdida de tiempo pero no daño.
- `medio`: el output puede influir en decisiones importantes o hay algún automatismo ligero.
- `alto`: el sistema puede ejecutar acciones con consecuencias difíciles de revertir, o involucra datos sensibles de personas.
- `critico`: el sistema puede ejecutar acciones irreversibles, financieras, legales o que afectan personas directamente.

`requiere_aprobacion` debe ser `true` siempre que el nivel sea 'alto' o 'critico'. Cuando los datos del proceso son sensibles (datos personales, información financiera, credenciales), subir el nivel un escalón respecto a lo que la acción sola indicaría.

El riesgo es una señal para el sistema de orquestación — no es autoridad ni diagnóstico moral. Declararlo con precisión para que el operador pueda enrutar correctamente.

### `suficiencia`

Booleano. La pregunta es: ¿el input en lenguaje natural contiene suficiente información para producir una FICHA completa y útil? Si el usuario dio contexto mínimo para al menos un objetivo parcial bien definido, suficiencia puede ser `true` con un objetivo de alcance reducido. Si el input es tan vago que cualquier objetivo posible sería especulativo, suficiencia es `false`.

No confundir suficiencia con completitud perfecta. Un input que permite un objetivo claro pero de alcance limitado es suficiente — se declara ese objetivo y se nota en entregable que el alcance fue reducido por falta de información adicional.

### `faltantes`

Lista de preguntas concretas y específicas si `suficiencia` es `false`. Cada pregunta debe ser accionable — el usuario debe poder responderla sin ambigüedad. "¿A qué mercado geográfico te refieres?" es buena pregunta. "¿Puedes darme más contexto?" no lo es.

Si `suficiencia` es `true`, este campo es una lista vacía.

### `skill_destino_sugerido`

Objeto con tres subfields: `nombre`, `razon`, `fallback`.

El skill destino es el skill que debería resolver el problema después de que la FICHA esté completa — no el siguiente paso en la secuencia abstracta, sino el skill que realmente RESUELVE lo que el usuario necesita. Si el objetivo requiere construir capacidad nueva que no existe en el sistema (un nuevo extractor, un nuevo analizador), el destino es `forge-analyze`, que tiene el criterio para decidir qué construir. Si existe un skill aprobado que cubre exactamente el caso, nombrarlo directamente.

La `razon` explica en una frase por qué ese skill es el correcto para este objetivo. El `fallback` es la alternativa si el skill sugerido no está disponible o no puede ejecutarse — generalmente `forge-analyze` cuando el destino principal es un skill más especializado.

`nombre` nunca debe quedar vacío. Si hay genuina incertidumbre, el fallback por defecto es `forge-analyze`.

---

## Cómo interpretar inputs vagos

La ambigüedad en el input del usuario no es un error — es información sobre el estado actual del problema. La respuesta correcta no es asumir el peor ni el mejor escenario, sino usar `suficiencia: false` con preguntas concretas en `faltantes` cuando el input genuinamente no permite un objetivo definido.

Cuando hay suficiente información para un objetivo parcial pero no uno completo, la estrategia correcta es declarar el objetivo de alcance reducido, marcar `suficiencia: true`, y añadir en el campo `entregable` una nota que indique que el alcance fue limitado por el input disponible. Esto permite avanzar sin bloquear el flujo, mientras deja trazabilidad de la decisión.

No fabricar especificidad donde no existe. Si el usuario dice "analiza mi negocio" sin más contexto, no hay objetivo definible — `suficiencia: false`, con preguntas que permitan al usuario precisar qué aspecto del negocio, qué período, qué decisión quiere tomar con el resultado.

---

## eje_temporal — la decisión más importante de la FICHA

Más que cualquier otro campo, el eje temporal determina la arquitectura de ejecución del proceso. Una confusión aquí produce consecuencias en cadena: un proceso continuo tratado como único no tiene scheduling, no tiene estado persistente, no tiene gestión de ciclos. Un proceso único tratado como continuo consume recursos indefinidamente.

La regla es directa: si el usuario pide algo "una vez", "ahora", "en este momento", "para esta semana" → `tipo: unico`. Si pide "estar al tanto", "avisarme cuando", "monitorear", "mantener actualizado", "cada semana", "saber si cambia" → `tipo: continuo`.

Cuando el ritmo no está explícito pero la intención es claramente continua, preguntar antes de asumir. Esta es la única pregunta que forge-intake puede hacer en modo semi sin completar primero la FICHA con lo que sí se sabe. El ritmo incorrecto tiene impacto directo en costos y en el diseño de los pasos mecánicos.

---

## riesgo_operativo — cómo calibrarlo correctamente

El error más común al llenar este campo es confundir dificultad técnica con riesgo operativo. Un proceso técnicamente complejo que solo produce un informe informativo tiene riesgo bajo. Un proceso técnicamente simple que envía correos o modifica registros en una base de datos tiene riesgo alto.

La pregunta de calibración es: si el proceso produce un resultado incorrecto y el sistema actúa sobre ese resultado, ¿qué pasa? Monitoreo sin acción automática → bajo o medio, dependiendo de la sensibilidad de los datos. Ejecución de acciones con consecuencias reversibles → medio. Ejecución de acciones difíciles de revertir o que afectan terceros → alto. Acciones irreversibles, financieras, legales, o sobre datos de personas → crítico.

El modificador de sensibilidad de datos aplica cuando el proceso maneja datos personales, credenciales, información financiera privada o información estratégica confidencial. En esos casos, subir el nivel un escalón respecto a lo que la acción sola indicaría.

`requiere_aprobacion: true` es obligatorio para niveles 'alto' y 'critico'. Es opcional pero recomendado para 'medio' cuando el proceso tiene algún componente de ejecución.

---

## skill_destino_sugerido — cómo elegirlo

El principio es que el skill destino resuelve el problema del usuario, no que es el siguiente nodo en un grafo de proceso. Pensar en términos de capacidad: ¿qué necesita existir para que el objetivo de la FICHA sea alcanzado?

Si el objetivo requiere una capacidad que ya existe en el sistema como skill aprobado, ese skill es el destino. La `razon` debe explicar qué hace ese skill que lo hace el candidato correcto para este objetivo específico.

Si el objetivo requiere construir algo nuevo — un extractor para una fuente que no tiene integración, un analizador para un dominio no cubierto, un pipeline que no existe — entonces el destino es `forge-analyze`, cuyo trabajo es decidir qué construir. No nombrar `forge-analyze` como destino cuando hay un skill aprobado que cubre el caso: eso añade un paso innecesario.

El `fallback` existe porque los skills pueden estar deshabilitados, en revisión o no disponibles en un entorno particular. Un fallback bien elegido permite que la FICHA siga siendo útil incluso si el destino principal no puede ejecutarse.

---

## Validación con validar_ficha.py

Después de producir la FICHA y antes de entregarla, ejecutar `validar_ficha.py` pasando el diccionario de los 11 campos como argumento. El script verifica coherencia interna: que `faltantes` esté vacío cuando `suficiencia` es `true`, que `ritmo` exista cuando `eje_temporal.tipo` es 'continuo', que `requiere_aprobacion` sea `true` cuando el nivel de riesgo es 'alto' o 'critico', y otras invariantes.

Si el script retorna `valida: false`, corregir todos los errores listados antes de entregar la FICHA. No entregar una FICHA inválida con la intención de corregirla después — los errores de coherencia en la FICHA se propagan a todos los pasos siguientes.

Si el script retorna advertencias pero `valida: true`, incluirlas en el output como notas al pie de la FICHA. Las advertencias no bloquean la entrega pero deben ser visibles.

Si el script retorna `requiere_revision_humana: true` (lo que ocurre cuando `riesgo_operativo.requiere_aprobacion` es `true` o cuando hay condiciones específicas de escalación), señalarlo claramente al usuario en el resumen que precede la FICHA. El usuario debe saber que el proceso no puede continuar de forma autónoma sin su aprobación explícita.

---

## Output format

Entregar siempre en dos partes, en este orden:

**Primero**, un párrafo de 2-3 líneas en prosa que explique al usuario qué entendiste del problema y qué hará el sistema con esa información. No repetir la FICHA en prosa — resumir la interpretación y el siguiente paso. Este párrafo es para el usuario, no para el sistema.

**Segundo**, la FICHA como JSON con los 11 campos en el orden declarado en este documento. El JSON debe ser parseable sin preprocesamiento — no incluir comentarios inline, no truncar valores, no usar elipsis.

Si `suficiencia` es `false`, el párrafo inicial debe indicarlo claramente y las preguntas de `faltantes` deben presentarse de forma legible, no solo como lista en el JSON.

---

## Errores comunes a evitar

No mezclar `datos_requeridos` con `fuentes_candidatas`. El primero responde "¿qué tipo de información necesito?" y el segundo responde "¿dónde podría estar esa información?". Poner una fuente en datos_requeridos (ej: "datos de Google Trends") confunde qué se necesita con dónde se obtiene, y hace la FICHA menos portable a entornos donde esa fuente no está disponible.

No declarar `eje_temporal.tipo: unico` cuando el usuario menciona cualquier variante de "mantenerse informado", "saber cuando cambie", "estar al tanto" o "seguimiento". Esas frases indican intención continua aunque el usuario no use la palabra "monitoreo".

No poner `riesgo_operativo.nivel: bajo` cuando el proceso incluye pasos de ejecución automática sobre sistemas externos. El nivel bajo es apropiado para procesos puramente informativos. Cualquier capacidad de actuar en el mundo, por pequeña que sea, implica al menos nivel medio.

No dejar `skill_destino_sugerido.nombre` vacío o como placeholder. Siempre sugerir algo concreto. Si genuinamente no hay certeza sobre qué skill es el correcto, el valor por defecto es `forge-analyze` con una `razon` que explique la incertidumbre. Un campo vacío no es una respuesta válida — es una señal de que el análisis del problema fue incompleto.
