---
name: forge-analyze
description: >-
  Analiza los registros extraídos y la ficha del problema para decidir
  qué capacidad (skill) resuelve el objetivo — reutilizar uno existente,
  modificar un canónico, o fabricar uno nuevo — y produce el ENCARGO DE
  FABRICACIÓN que la factory necesita para construir o configurar esa
  capacidad. Activarlo cuando hay datos extraídos disponibles y se necesita
  decidir qué skill resuelve el problema. Frases de activación: "¿qué skill
  necesito para esto?", "¿existe algo que resuelva este problema?",
  "arma el encargo para la factory", "decide si reusar o crear". No usar
  para analizar datos de negocio ni para responder preguntas sobre el
  dominio — este skill analiza capacidades, no contenido.
forge_approved: false
forge_autonomy: semi
forge_output_format: text
forge_capabilities:
  agentic: true
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
      validar_encargo.py verifica coherencia del ENCARGO — que evidencia_usada
      referencie registro_ids reales, que nivel_generalizacion sea el mínimo
      necesario, y que la reaprobacion_requerida sea correcta según el verbo
forge_capabilities_detail:
  agentic:
    can_run_unattended: false
    next_pipeline: factory
    on_completion: chain
  external_apis: []
  scheduling:
    enabled: false
  storage:
    artifacts: ephemeral
    shared: false
---

# forge-analyze — Análisis de capacidades y producción del ENCARGO DE FABRICACIÓN

## Rol y contexto

Este skill cierra el ciclo de comprensión y abre el ciclo de fabricación. Los skills anteriores del pipeline FORGE resolvieron el problema del conocimiento: qué se quiere (forge-intake), de dónde vienen los datos (forge-sources), qué datos llegaron realmente (forge-extract). forge-analyze resuelve el problema de la capacidad: qué skill del sistema puede convertir esos datos en el resultado que el usuario necesita, y si ese skill debe construirse o ya existe.

El output de forge-analyze no es un análisis de los datos del ResultadoExtraccion. Los datos son evidencia, no el objeto de estudio. El objeto de estudio es la brecha entre lo que el sistema sabe hacer y lo que el objetivo de la FICHA requiere que haga. El ENCARGO DE FABRICACIÓN que este skill produce define exactamente qué debe construir la factory: con qué verbo, a qué nivel de generalización, con qué evidencia específica como justificación, y con qué alcance.

Un encargo sobredimensionado crea skills demasiado genéricos que no sirven a nadie. Un skill que "analiza noticias para cualquier industria en cualquier contexto" es un skill que no tiene criterio propio para decidir qué es relevante — delega esa decisión a quien lo usa, que es exactamente lo que el sistema debería evitar. Un encargo infra-especificado produce skills que no resuelven el problema real: el skill se construye para lo que el encargo dice, y si el encargo dice algo vago, el skill hace algo vago. La precisión del ENCARGO determina directamente la utilidad del skill resultante.

---

## Los 3 verbos — el principio más importante

Todo ENCARGO tiene exactamente un verbo. El verbo no describe qué hace el skill — describe qué relación tiene el skill resultante con las capacidades que ya existen en el sistema. Hay tres verbos posibles y su secuencia de evaluación es fija.

### `reusar`

Existe un skill aprobado en el sistema que resuelve exactamente este problema con los parámetros actuales. El ENCARGO con verbo `reusar` no construye nada nuevo — le dice a la factory cómo parametrizar el skill existente para este caso específico. No modifica el comportamiento del skill, no extiende sus capacidades, no cambia su lógica interna. Solo lo configura.

Un ENCARGO de reusar tiene `reaprobacion_requerida: false` porque nada del comportamiento aprobado cambia. La responsabilidad de este verbo es alta: declarar que un skill existente resuelve exactamente el problema sin verificarlo es un error que produce resultados incorrectos en silencio.

### `modificar`

Existe un skill canónico que resuelve el problema base, pero necesita extensión o ajuste para este caso específico. El caso específico tiene una dimensión que el skill canónico no cubre: una fuente de datos adicional, un criterio de clasificación diferente, un formato de salida distinto, una regla de negocio específica del cliente.

El verbo `modificar` siempre genera `reaprobacion_requerida: true`. La razón es que cualquier modificación al comportamiento de un skill aprobado invalida la aprobación existente — el skill modificado es un skill diferente aunque comparta la mayor parte de su lógica con el original. El humano que aprobó el skill canónico aprobó exactamente esa configuración, no las variantes derivadas de ella.

### `fabricar`

No existe nada adecuado en el sistema. La capacidad que el objetivo requiere no está cubierta por ningún skill existente ni por ninguna variación razonable de uno existente. Hay que construir desde cero.

El verbo `fabricar` también genera `reaprobacion_requerida: true`. Un skill nuevo, por definición, no tiene historial de aprobación.

### La secuencia de evaluación es obligatoria

Siempre en este orden: ¿puedo reusar? → ¿puedo modificar? → ¿debo fabricar?

Nunca fabricar cuando modificar alcanza. Nunca modificar cuando reusar alcanza. La tentación de fabricar cuando el problema parece nuevo o interesante es el error más costoso de este skill — produce proliferación de capacidades redundantes que el sistema no puede mantener. Fabricar es la decisión de mayor costo de ciclo de vida: requiere construcción, prueba, aprobación, y mantenimiento indefinido. Modificar es menos costoso. Reusar es el mínimo posible.

---

## nivel_generalizacion — fabricar al nivel más específico posible

Cuando el verbo es `fabricar` o `modificar`, el ENCARGO debe declarar a qué nivel de generalización se construye el skill resultante. Hay tres niveles posibles y la regla es siempre fabricar al nivel más específico que el problema justifica.

### `cliente`

El skill resuelve el problema de esta organización específica, con sus datos, sus procesos y sus convenciones. Un clasificador de alertas de licitaciones para el sistema de compras públicas de un cliente determinado es un skill de nivel `cliente`: sabe qué categorías de licitación importan a ese cliente, qué umbrales de monto son relevantes para su escala de operaciones, qué regiones geográficas cubre.

La mayoría de los encargos que llegan a forge-analyze son de nivel `cliente`. El problema que motivó la FICHA es el problema de alguien concreto con una necesidad concreta. Generalizar ese problema sin evidencia de que es genérico es inflar el alcance sin justificación.

### `vertical`

El skill resuelve el mismo tipo de problema para cualquier empresa del mismo sector, sin depender de los datos o procesos específicos de un cliente en particular. Un monitor de cambios regulatorios para el sector farmacéutico es de nivel `vertical`: aplica a cualquier empresa farmacéutica, no a una sola.

Solo subir de `cliente` a `vertical` cuando hay evidencia clara de que el problema es estructuralmente idéntico en múltiples organizaciones del mismo sector, Y cuando el cliente que motivó la construcción aprueba explícitamente que el skill resultante sea reutilizable más allá de su caso.

### `universal`

El skill resuelve el problema para cualquier organización de cualquier sector. El nivel `universal` exige revisión humana siempre, sin excepción. Un skill universal debe ser tan genérico que su utilidad en cualquier contexto específico es baja — el tradeoff entre generalidad y precisión se resuelve a favor de la generalidad, lo que generalmente significa que el skill requiere configuración extensiva para ser útil en cualquier caso concreto.

### La regla anti-inflación

Si el problema es de un cliente específico, fabricar al nivel `cliente`, no `vertical`. Si el sector es homogéneo pero no hay aprobación explícita del cliente para generalizar, fabricar al nivel `cliente` con una nota de que podría elevarse a `vertical` en una iteración posterior con esa aprobación.

El nivel 'universal' es excepcional. La evidencia necesaria para justificarlo es alta: el problema debe ser reconociblemente idéntico en múltiples sectores sin adaptación, la factory debe estar de acuerdo, y un humano debe revisar antes de construir.

---

## evidencia_usada — trazabilidad causal

El ENCARGO no toma decisiones desde el vacío. Cada decisión relevante — el verbo elegido, el nivel de generalización, la especificación del skill, el riesgo acumulado — tiene una razón que puede trazarse hasta registros concretos del ResultadoExtraccion.

Cada entrada en `evidencia_usada` tiene dos campos:
- `registro_id`: el identificador en formato `"src-N:rM"` de un registro real del ResultadoExtraccion recibido.
- `razon`: por qué ese registro específico motivó una decisión específica del encargo.

La razón debe ser causal, no descriptiva. "El registro contiene datos de precios" es descriptivo. "El registro revela que los precios varían por categoría de producto, lo que requiere que el skill tenga lógica de segmentación por categoría en lugar de calcular un promedio único" es causal.

No citar fuentes abstractas en evidencia_usada. No escribir "los datos de la extracción" ni "la información disponible" — citar `"src-0:r3"` con la razón específica de por qué ese registro cambió una decisión del encargo. Si ningún registro específico justifica una decisión, esa decisión está flotando sin evidencia y debe revisarse.

El validador verifica que todos los registro_ids citados en evidencia_usada existan realmente en el ResultadoExtraccion recibido. Una referencia a un registro_id que no existe en el resultado es un error que invalida el encargo.

---

## especificacion_factory — las 5 variables de la FACTORY

La `especificacion_factory` es el núcleo del ENCARGO. Es lo que la factory realmente usa para construir o configurar el skill. Tiene exactamente 5 variables y las 5 son obligatorias.

### `verbo_central`

Qué hace el skill en una frase. No qué es, no para qué sirve en abstracto — qué acción ejecuta cuando se activa. La prueba de un buen verbo_central es que permite saber en cada caso concreto si el skill hizo su trabajo: "clasifica noticias de competencia por impacto estratégico en bajo, medio o alto según el criterio X" permite saber si el resultado es correcto. "Analiza noticias" no lo permite.

### `señal_disparo`

Cuándo activar el skill, qué frases o contextos lo triggean, qué condiciones deben cumplirse para que su activación sea apropiada. También debe incluir los casos donde el skill no debe activarse aunque parezca apropiado — la distinción negativa es tan importante como la positiva para que el sistema de despacho no lo active en el contexto equivocado.

### `formato_salida`

Qué produce el skill cuando completa su trabajo. Texto narrativo, JSON con estructura específica (incluyendo la estructura esperada), alerta tipo push, tabla con columnas definidas, archivo en formato específico. Si el formato varía según el caso de uso, declarar la variación y su condición. Un formato_salida impreciso produce outputs que el sistema aguas abajo no puede consumir de manera confiable.

### `complejidad`

Qué necesita el skill además de su SKILL.md. Solo SKILL.md para skills puramente instruccionales. Scripts auxiliares si hay lógica de validación o transformación que debe ser determinista. Adaptadores si necesita acceder a fuentes externas. Modelos o índices si tiene componente de búsqueda vectorial. Esta variable permite que la factory estime el trabajo de construcción antes de empezar.

### `distincion`

Con qué skills adyacentes podría confundirse el sistema de despacho, y qué los diferencia. Un skill bien distinguido tiene criterios de activación que no se superponen con los de otros skills. Si la distinción no es posible — si dos skills hacen cosas demasiado similares — esa es una señal de que el encargo está duplicando capacidad existente y el verbo correcto podría ser `modificar` en lugar de `fabricar`.

---

## riesgo_acumulado — consolidación de la cadena completa

El ENCARGO no evalúa el riesgo desde cero. Consolida los riesgos que cada eslabón del pipeline ha declarado:

1. El `riesgo_operativo` de la FICHA — el riesgo del proyecto desde la perspectiva del objetivo y la acción.
2. Los `riesgo` individuales de las fuentes del PLAN — especialmente las fuentes de riesgo alto sin redundancia.
3. La calidad de los datos extraídos — cobertura incompleta, fuentes omitidas, registros con campos ausentes.

La regla de propagación es que el riesgo no se promedia ni se resetea — se hereda el nivel máximo de cualquier eslabón. Si la FICHA tenía riesgo medio pero una fuente del PLAN era de riesgo alto por ser la única fuente de un dato crítico, el encargo tiene riesgo_acumulado alto. Si la extracción tuvo pérdida significativa de cobertura, eso añade riesgo porque el skill que se construya operará con información incompleta.

Un encargo que baja el riesgo respecto a los eslabones anteriores está ocultando información. La factory necesita saber el nivel real de riesgo para decidir con qué nivel de cautela construye el skill.

---

## basado_en_datos_completos vs datos_faltantes

`basado_en_datos_completos: true` solo cuando el ResultadoExtraccion cubrió el 100% de los `datos_requeridos` de la FICHA. Si hay algún dato requerido que no aparece en `datos_cubiertos` del resultado, `basado_en_datos_completos: false` y el campo `datos_faltantes` debe listar exactamente cuáles son, tomados directamente de `datos_faltantes` del ResultadoExtraccion.

Datos faltantes no bloquean la producción del encargo. Un skill puede diseñarse para operar con información incompleta — pero debe diseñarse conscientemente para ese caso, no ignorar que la información falta. La factory necesita saber que el skill que construya recibirá datos incompletos para que lo diseñe con los fallbacks y la gestión de incertidumbre apropiados.

Si los datos faltantes son centrales para el objetivo (sin ellos el skill no puede cumplir su verbo_central de manera confiable), declararlo explícitamente en el encargo. El skill resultante puede quedar como borrador hasta que se consigan esos datos, o puede construirse con una capa de manejo explícito de la ausencia.

---

## requiere_revision_humana — cuándo forzarla

Esta bandera no bloquea la generación del encargo. Señala que antes de que la factory construya el skill resultante, un humano debe revisar el encargo y aprobarlo explícitamente. Las condiciones que la activan son acumulativas — cualquiera de las siguientes es suficiente:

- **Verbo `fabricar` o `modificar`**: siempre. El skill resultante no existe todavía o modifica uno aprobado — ningún sistema automatizado puede decidir unilateralmente que eso es apropiado.
- **`nivel_generalizacion: universal`**: siempre. Un skill universal tiene alcance e implicaciones que trascienden el caso que lo originó.
- **`riesgo_acumulado` alto o crítico**: siempre. El nivel de riesgo justifica supervisión humana antes de que se construya capacidad nueva o modificada en ese contexto.
- **`basado_en_datos_completos: false` y los datos faltantes son críticos para el verbo_central**: sí. Construir un skill sobre evidencia materialmente incompleta para su propósito central es una decisión que un humano debe tomar con conocimiento explícito de lo que falta.

Cuando `requiere_revision_humana: true`, el resumen en prosa que acompaña al ENCARGO debe describir claramente qué debe revisar el humano y qué decisión se le pide. No es suficiente señalar la bandera — hay que decir qué mirar.

---

## next_pipeline: factory

Al completar el ENCARGO, si el modo de autonomía lo permite y el verbo no es `reusar`, forge-analyze señala que el siguiente paso es la factory. El comportamiento concreto depende del modo:

- **Modo `autonomous`**: el encadenamiento a la factory es automático si `requiere_revision_humana: false`. Si la bandera está activa, el sistema espera aprobación humana antes de continuar.
- **Modo `semi`**: forge-analyze pregunta antes de encadenar, independientemente del valor de `requiere_revision_humana`. La pregunta es concreta: "El ENCARGO está listo. ¿Procedo con la factory para construir el skill?"
- **Modo `supervised`**: nunca encadena automáticamente. Entrega el ENCARGO y espera instrucción explícita.

Para el verbo `reusar`, no hay encadenamiento a factory — hay encadenamiento directo al skill identificado como reutilizable, con los parámetros definidos en el ENCARGO.

---

## Validación con validar_encargo.py

Después de producir el ENCARGO y antes de entregarlo, ejecutar `validar_encargo.py` pasándole el ENCARGO generado y el ResultadoExtraccion recibido. El script realiza cuatro verificaciones independientes:

**(a) Trazabilidad de evidencia**: todos los `registro_id` listados en `evidencia_usada` deben existir como registros reales en el ResultadoExtraccion. Una referencia a un registro que no existe invalida la cadena de trazabilidad y es un error que debe corregirse antes de entregar.

**(b) Coherencia de reaprobacion_requerida**: si el verbo es `modificar` o `fabricar`, `reaprobacion_requerida` debe ser `true`. Si el validador encuentra `reaprobacion_requerida: false` con esos verbos, es un error en el encargo — no en el validador.

**(c) Protección del nivel universal**: si `nivel_generalizacion` es `universal`, `requiere_revision_humana` debe ser `true`. Un skill de nivel universal sin revisión humana obligatoria es un error de diseño del encargo.

**(d) Completitud de especificacion_factory**: las 5 variables (`verbo_central`, `señal_disparo`, `formato_salida`, `complejidad`, `distincion`) deben estar presentes y no vacías. Un encargo con variables ausentes no puede ejecutarse en la factory.

Si el validador retorna errores, corregir todos antes de entregar. No entregar un encargo inválido — los errores de coherencia en el ENCARGO se propagan al skill que la factory construya, y corregir un skill mal especificado cuesta más que corregir el encargo.

Si el validador retorna advertencias pero `valido: true`, incluirlas en el resumen como notas visibles. Las advertencias no bloquean la entrega pero deben ser consideradas por quien revisa.

---

## Output format

El output de forge-analyze tiene dos partes entregadas juntas, en este orden:

**Primero**, el ENCARGO DE FABRICACIÓN como JSON completo con los siguientes campos en este orden: `verbo`, `skill_objetivo`, `nivel_generalizacion`, `reaprobacion_requerida`, `basado_en_datos_completos`, `datos_faltantes`, `riesgo_acumulado`, `requiere_revision_humana`, `evidencia_usada`, `especificacion_factory`. El JSON debe ser parseable sin preprocesamiento — sin comentarios inline, sin truncamiento, sin elipsis.

**Segundo**, un resumen en prosa de 3-4 líneas que cubre: qué decisión se tomó (el verbo y por qué ese verbo), qué evidencia concreta la sostiene (citando registro_ids específicos), y qué debe hacer el operador humano si algo requiere su atención — incluyendo qué revisar si `requiere_revision_humana: true`, o una confirmación explícita de que el encargo puede procesarse automáticamente si no lo requiere. El resumen es para el humano que recibe el output, no para el sistema — debe ser legible sin leer el JSON.
