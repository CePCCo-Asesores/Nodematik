---
name: forge-sources
description: >-
  Evalúa fuentes candidatas de datos y construye un PLAN con disponibilidad,
  método de acceso, riesgo y cobertura demostrada. Activarlo cuando hay una
  lista de fuentes candidatas y se necesita decidir cuáles son accesibles,
  cuáles requieren credenciales del cliente, cuáles descartar y cuánto del
  objetivo cubren en conjunto. Frases de activación: "¿de dónde saco estos
  datos?", "evalúa estas fuentes", "¿cuál de estas APIs puedo usar?",
  "¿tengo acceso a...?". No usar para identificar fuentes desde cero — eso
  viene en la FICHA de forge-intake. No usar para extraer datos — eso es
  forge-extract.
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
      validar_plan.py demuestra cobertura recalculando desde cero — no
      confía en lo declarado, verifica honestamente que las fuentes
      disponibles cubran los datos requeridos
  external_apis: []
  scheduling:
    enabled: false
  storage:
    artifacts: ephemeral
    shared: false
---

# forge-sources — Evaluación de fuentes y construcción del PLAN

## Rol y contexto

Este skill toma las fuentes candidatas que forge-intake identificó en la FICHA y las convierte en un PLAN concreto: un mapa de decisiones que le dice a forge-extract exactamente de dónde vienen los datos, cómo acceder a ellos y qué esperar de cada fuente.

La diferencia entre una FICHA y un PLAN es la diferencia entre "hay noticias sobre este tema en Google News" y "accedo a Google News vía RSS con id `google-news-rss`, sin credenciales, cubre los campos `titular`, `fecha` y `url_original`, con riesgo bajo porque hay redundancia con otras fuentes de noticias". El PLAN elimina la ambigüedad para que la extracción pueda ejecutarse sin interrupciones para preguntar cosas que debieron resolverse antes.

Un PLAN sobreoptimista destruye la extracción: declarar como disponible una fuente que en realidad requiere credenciales que el cliente no ha confirmado tener significa que forge-extract llega a ese punto, falla, y no hay forma de saber si la falla es transitoria o estructural. Un PLAN demasiado conservador, en cambio, descarta fuentes válidas y deja datos sin obtener que podrían haberse conseguido. El criterio correcto está en clasificar con la información que realmente se tiene, no con la que se asume o espera.

## El principio fundamental: disponible = accesible + permitido

Técnicamente accesible significa que la URL existe, el endpoint responde, el archivo puede descargarse. Pero accesible no es suficiente. Permitido significa que los términos de servicio de la fuente, las políticas de robots.txt, las licencias de los datos y el contexto del cliente autorizan ese uso específico.

Una API pública puede ser accesible sin credenciales, pero si sus términos prohíben uso comercial y el cliente tiene un caso de uso comercial, la fuente no está permitida y no puede marcarse como `disponible`. Un sitio web puede tener contenido público, pero si robots.txt deniega el scraping o los ToS lo prohíben explícitamente, la fuente no está permitida para `web`. Ambas condiciones deben cumplirse simultáneamente. Cuando solo una se cumple, el estado no puede ser `disponible`.

El modelo BYO (Bring Your Own) cambia el análisis para fuentes que requieren credenciales de pago o acceso restringido. Si el cliente declara que tiene su propia API key para un servicio de pago, esa fuente deja de ser dudosa o descartada y pasa a ser `condicional` — técnicamente accesible en cuanto el cliente confirme y provea la credencial, y permitida porque es la cuenta propia del cliente. BYO expande el perímetro de lo que está permitido, pero no elimina la necesidad de confirmar que la credencial existe realmente antes de marcarla disponible.

## Los cuatro estados de fuente y el criterio para cada uno

**`disponible`** es el estado de máxima confianza: la fuente es accesible ahora, sin credenciales adicionales pendientes de confirmar, y está permitida para el uso específico del cliente. forge-extract puede ir directamente a esta fuente sin intervención humana. La responsabilidad de asignar este estado es alta — implica afirmar que se verificaron tanto el acceso técnico como el permiso. Si hay cualquier duda sobre alguna de las dos condiciones, el estado correcto no es `disponible`.

**`condicional`** significa que la fuente existe, el acceso técnico está entendido, pero se necesita algo del cliente para proceder. Ese algo debe especificarse en el campo `requiere_del_cliente` con precisión quirúrgica: no "credenciales de acceso" sino "API key del plan Pro de NewsAPI, con scopes para búsqueda histórica". El orquestador usa ese campo para construir exactamente el prompt de recolección que le presenta al cliente. Una fuente `condicional` bien documentada es casi tan valiosa como una `disponible` porque el camino para activarla está claro. Una fuente `condicional` con `requiere_del_cliente` vago bloquea al orquestador igual que si estuviera `descartada`.

**`descartada`** es una decisión definitiva dentro del contexto de este PLAN. Una fuente se descarta cuando no es accesible (el endpoint no existe, el sitio bloquea acceso programático de forma consistente), cuando no está permitida y no hay forma realista de cambiar eso, o cuando el costo y esfuerzo de obtener los datos de esa fuente supera con claridad el valor que aportan comparado con fuentes alternativas. Al descartar, documentar el motivo con suficiente detalle para que la decisión pueda revisarse — quien lee el PLAN meses después necesita entender por qué se descartó, no solo que se descartó.

**`dudosa`** es el estado honesto cuando la información disponible no alcanza para clasificar la fuente de forma confiable. No descartar prematuramente por incertidumbre — descartar requiere certeza de que la fuente no sirve. Dudosa comunica: "esta fuente podría ser valiosa pero necesito que el cliente aclare X antes de poder decidir". El campo `requiere_aclarar` debe ser tan específico como `requiere_del_cliente`: no "confirmar acceso" sino "confirmar si la base de datos de CRM es Salesforce o HubSpot y si tiene API habilitada en el plan contratado".

## El campo `id` — por qué no es un detalle menor

El `id` de cada fuente no es un label decorativo. Es la clave primaria que el orquestador de forge-extract usa para despachar al adaptador correcto, que el sistema de credenciales usa para asociar las claves del cliente con la fuente correspondiente, y que la cadena de trazabilidad usa para conectar cada registro extraído con su origen.

Un id inestable rompe todos esos mecanismos. Las URLs son inestables por definición — cambian cuando el proveedor reestructura sus endpoints, cuando la fuente migra de dominio, cuando la versión de la API avanza. Usar `https://newsapi.org/v2/everything` como id significa que cuando newsapi cambie a v3, todos los registros trazados a ese id se desconectan de su origen sin que nada falle ruidosamente — simplemente quedan huérfanos.

Los ids deben ser semánticos y estables: `newsapi-everything`, `cliente-crm-contactos`, `google-news-rss-mx`, `datos-gob-mx-padron-empresas`. El patrón es `{proveedor}-{recurso}` o `cliente-{nombre-del-recurso}` para fuentes que el cliente provee directamente. Si dos fuentes del mismo proveedor sirven recursos distintos, deben tener ids distintos — `twitter-search-reciente` y `twitter-search-historico` son fuentes diferentes con comportamientos, límites de tasa y credenciales potencialmente distintos.

## El campo `metodo_acceso` — cinco métodos, no más

Los cinco métodos válidos cubren todos los casos legítimos:

**`api`** es para REST o GraphQL con endpoint documentado. La documentación importa — un endpoint sin documentación que se descubrió a través de ingeniería inversa no es un método de acceso estable y no debería categorizarse como `api` sin una nota de advertencia sobre su fragilidad.

**`feed`** es para RSS o Atom. Lectura pasiva de feeds públicos, generalmente sin autenticación. Es el método de menor fricción y menor riesgo legal porque es exactamente el mecanismo que el publicador diseñó para distribución masiva de su contenido.

**`web`** es scraping. Es el método con mayor carga de verificación de permisos porque es el más propenso a violar términos de servicio. Antes de clasificar cualquier fuente con este método, verificar robots.txt del dominio y los ToS de manera explícita. Si los ToS tienen cláusulas ambiguas, marcar `dudosa` con la nota de la ambigüedad — no asumir permiso donde no está claro. Incluir siempre `nota_permiso` para fuentes con este método.

**`archivo_cliente`** es para archivos que el cliente provee directamente: CSV exportado de su sistema, JSON de un dump, Excel con datos históricos. Este método implica que la extracción no es automática en el sentido técnico — requiere que el cliente entregue el archivo. El campo `requiere_del_cliente` debe especificar el formato esperado, la estructura mínima aceptable y si hay alguna transformación esperada antes de entregarlo.

**`dataset_abierto`** es para datasets públicos descargables de fuentes institucionales: Kaggle, datos.gob.mx, portales de datos abiertos de gobiernos o instituciones académicas. Verificar la licencia del dataset — "abierto" no siempre significa "sin restricciones de uso comercial".

Si una fuente no encaja en ninguno de estos cinco métodos, el estado correcto es `dudosa` con una nota que explique qué hace diferente a esa fuente. No inventar un sexto método — eso es señal de que falta información para clasificar la fuente correctamente.

## Cobertura — declarar solo lo que se puede demostrar

Para cada fuente con estado `disponible`, el campo `datos_que_cubre` debe listar exactamente qué elementos de `datos_requeridos` (de la FICHA) cubre esa fuente. No interpretar liberalmente — "noticias" no cubre automáticamente "titular", "fecha de publicación", "URL canónica" y "sentimiento" a menos que la fuente provea cada uno de esos campos de forma confiable.

La cobertura total del PLAN es la unión de los `datos_que_cubre` de todas las fuentes `disponibles`, intersectada con `datos_requeridos`. Si un dato requerido no aparece en ninguna fuente `disponible`, la cobertura no es completa. Punto. No declarar cobertura completa por optimismo o por no querer entregar malas noticias. Los datos faltantes deben reportarse explícitamente en el resumen junto con su implicación: ¿son opcionales? ¿bloquean el caso de uso principal? ¿podrían obtenerse si el cliente confirma una fuente `condicional` o `dudosa`?

Esto es exactamente lo que `validar_plan.py` recalcula de forma independiente. El validador no lee las declaraciones del PLAN — toma la lista de `datos_requeridos` de la FICHA y la lista de `datos_que_cubre` de las fuentes `disponibles` y calcula la intersección desde cero. Si el resultado no coincide con lo declarado en el PLAN, hay un error en el PLAN que debe corregirse antes de continuar.

## Riesgo de fuente — distinto del riesgo operativo de la FICHA

El `riesgo_operativo` de la FICHA evalúa el riesgo del proyecto completo. El `riesgo` de cada fuente en el PLAN evalúa algo más específico: ¿qué pasa si esta fuente falla o entrega datos incorrectos?

Una fuente tiene riesgo alto cuando es la única fuente para un dato crítico sin redundancia. Si falla, ese dato queda sin cubrir y el caso de uso puede colapsar. Una fuente tiene riesgo bajo cuando hay otras fuentes que cubren el mismo dato — si esta falla, la extracción puede continuar degradada pero funcional.

El historial de la fuente importa cuando se conoce. APIs con downtime frecuente documentado, feeds que publican con irregularidad, datasets que se actualizan con retraso o que han tenido períodos de discontinuidad — todo eso sube el riesgo aunque la fuente esté disponible en este momento. No inventar historial, pero sí mencionar cuando se conoce algo concreto sobre la confiabilidad de la fuente.

## nota_permiso — no es opcional en ciertos casos

`nota_permiso` es obligatoria en tres situaciones que no tienen excepción:

Primero, cualquier fuente con `metodo_acceso: web`. Documentar que se revisó robots.txt (y el resultado de esa revisión) y los ToS relevantes. Si la revisión fue superficial o incompleta, decirlo — es mejor documentar incertidumbre que dar falsa certeza sobre algo que puede tener consecuencias legales para el cliente.

Segundo, cualquier fuente que involucre datos personales o sensibles, independientemente del método de acceso. El hecho de que una base de datos sea técnicamente accesible no resuelve las implicaciones de privacidad.

Tercero, cualquier fuente donde la licencia de uso de los datos no sea obvia. "Datos públicos" no significa "datos de uso libre" — muchas fuentes de datos públicos tienen licencias que restringen el uso comercial, la redistribución o la creación de derivados.

## Ejecución de validar_plan.py

Después de producir el PLAN completo, ejecutar `validar_plan.py` pasándole el PLAN generado y los `datos_requeridos` de la FICHA. El script recalcula la cobertura de forma independiente. Su propósito no es validar la forma del JSON sino verificar que la realidad del PLAN (lo que realmente cubre) coincide con lo declarado.

Si `validar_plan.py` reporta divergencia, el PLAN tiene un error que debe corregirse antes de entregar. Las causas más comunes son: `datos_que_cubre` declarando datos que la fuente no provee realmente, o cobertura total declarada como completa cuando hay datos requeridos sin fuente disponible. Corregir el PLAN, no el validador.

## Formato del output

El output de este skill tiene dos partes que se entregan juntas:

La primera es el PLAN como JSON con un array de fuentes. Cada fuente incluye: `id`, `nombre`, `estado`, `metodo_acceso`, `datos_que_cubre` (para fuentes disponibles), `requiere_del_cliente` (para fuentes condicionales), `requiere_aclarar` (para fuentes dudosas), `riesgo`, `nota_permiso` (cuando aplica), y `motivo_descarte` (para fuentes descartadas).

La segunda es un resumen en prosa de no más de cuatro párrafos que cubre: cuántas fuentes quedaron en cada estado y por qué, qué cobertura total se logra con las fuentes disponibles, qué datos quedan sin cubrir y qué camino existe para cubrirlos (fuentes condicionales pendientes de credencial, fuentes dudosas pendientes de aclaración, o genuinamente sin fuente viable identificada), y cualquier riesgo de fuente que merezca atención especial.

## Errores que invalidan el PLAN

Marcar `disponible` una fuente que requiere credenciales de pago sin que el cliente haya confirmado que las tiene es el error más costoso — bloquea la extracción en un punto que no da señal clara de qué falló y por qué. La regla es simple: si hay alguna credencial pendiente de confirmar, el estado es `condicional`, no `disponible`.

Usar una URL como `id` es un error silencioso que produce deuda técnica garantizada. Las URLs cambian. Los ids semánticos no deberían cambiar a menos que el recurso mismo cambie de naturaleza.

Omitir `requiere_del_cliente` para fuentes `condicionales` hace que el orquestador no pueda construir el prompt de recolección correcto. El resultado es una conversación con el cliente donde se le pide información vaga ("necesitamos credenciales de esta fuente") en lugar de precisa ("necesitamos tu API key de Clearbit con acceso al endpoint de enriquecimiento de empresas").

Declarar cobertura total cuando hay datos requeridos sin fuente disponible es deshonestidad operacional. forge-extract asume que el PLAN es preciso. Si el PLAN dice cobertura completa y no la hay, forge-extract termina su trabajo y el dato faltante nunca se reporta como faltante — simplemente está ausente en silencio. Ser explícito sobre los datos que no tienen cobertura es la única forma de que el sistema completo se comporte de manera confiable.
