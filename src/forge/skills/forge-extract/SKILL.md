---
name: forge-extract
description: >-
  Extrae datos desde las fuentes del PLAN producido por forge-sources.
  Skill mecánico — su lógica corre como código determinista, no como LLM.
  Orquesta los adaptadores por método de acceso, sella registro_id único
  por registro, calcula cobertura honestamente y entrega ResultadoExtraccion.
  No activar vía LLM en producción — el orquestador del backend lo invoca
  directamente. Su SKILL.md es especificación de referencia y contrato.
forge_approved: false
forge_autonomy: semi
forge_output_format: text
forge_capabilities:
  agentic: false
  multimodal: false
  proactive: false
  dynamic_flow: false
  integrations: true
forge_runtime:
  database:
    enabled: false
  code_execution:
    enabled: true
    language: python
    purpose: >-
      5 adaptadores (feed, api, web, archivo, dataset) más orquestador
      y validador — toda la lógica de extracción es determinista y no
      requiere LLM
  external_apis:
    - name: fuentes-del-plan
      type: rest
      auth: api_key
      base_url: variable-por-fuente
  scheduling:
    enabled: false
  storage:
    artifacts: ephemeral
    shared: false
---

# forge-extract — Extracción de datos desde el PLAN

## Rol y restricciones

forge-extract es el único punto del pipeline FORGE que toca el mundo exterior. No razona sobre qué fuentes usar ni evalúa si los datos son correctos — eso lo hizo forge-sources. Lo que hace forge-extract es concreto y mecánico: recibe el PLAN, despacha cada fuente al adaptador correspondiente, sella cada registro que llega, mide honestamente qué se obtuvo y entrega un `ResultadoExtraccion` que refleja la realidad de la extracción, no los deseos del plan.

Dos invariantes son absolutas e inviolables:

**Primera**: nunca declarar cobertura mayor a la real. Si un adaptador falla para una fuente, esa fuente no cuenta en el cálculo de cobertura. No se estima, no se imputa, no se proyecta. La cobertura declarada en el resultado corresponde exclusivamente a registros que fueron obtenidos, procesados y sellados exitosamente. Un PLAN que prometía 90% de cobertura y del que solo se extrajeron fuentes que cubren el 60% debe producir un `ResultadoExtraccion` con `cobertura_pct: 60`, no con el 90 que el PLAN esperaba.

**Segunda**: jamás inventar contenido que no llegó de la fuente. Los adaptadores parsean y estructuran lo que reciben. No complementan campos faltantes, no infieren valores, no "completan" registros parciales con datos plausibles. Un campo que no llegó de la fuente es un campo ausente en el registro, no un campo con valor sustituto. La confiabilidad del pipeline completo depende de que el contenido en cada `Registro` sea exactamente lo que la fuente entregó.

---

## El contrato de datos — los tipos centrales

### `Registro`

La unidad atómica de información extraída. Un `Registro` representa un ítem discreto obtenido de una fuente: una entrada de feed, un resultado de API, un párrafo de página web, una fila de CSV, un objeto de JSON descargado.

Campos:

- **`contenido`** — el texto o dato extraído de la fuente, sin modificar ni complementar.
- **`fuente`** — el `id` de la fuente del PLAN de la que proviene este registro. Permite trazar cualquier registro hasta su origen.
- **`metodo_acceso`** — el método que produjo este registro (`feed`, `api`, `web`, `archivo_cliente`, `dataset_abierto`). Generalmente coincide con el método declarado en el PLAN para esa fuente.
- **`registro_id`** — identificador único sellado por el orquestador en formato `"src-N:rM"`, donde N es el índice de la fuente en el PLAN (base 0) y M es el contador de registro dentro de esa fuente (base 1). El adaptador no asigna este campo — llega vacío del adaptador y el orquestador lo sella antes de agregar el registro al resultado.
- **`datos_cubiertos`** — subconjunto de `datos_requeridos` (de la FICHA original) que este registro cubre. Es declarado por el adaptador según lo que el registro efectivamente contiene, no según lo que la fuente prometía cubrir.
- **`metadatos`** — diccionario con información de procedencia específica al método: URL para `web` y `api`, path para `archivo_cliente`, URL de descarga y nombre de archivo para `dataset_abierto`, URL de entrada y guid para `feed`.
- **`obtenido_en`** — timestamp ISO 8601 del momento en que el adaptador completó la extracción de este registro.

### `ResultadoExtraccion`

El output completo de una ejecución de forge-extract. Contiene todos los registros exitosos y una contabilidad honesta de lo que se logró y lo que no.

Campos:

- **`registros`** — lista de todos los `Registro` sellados, de todas las fuentes exitosas, en orden de procesamiento.
- **`fuentes_usadas`** — lista de ids de fuentes para las que se obtuvieron al menos un registro exitoso.
- **`fuentes_omitidas`** — lista de objetos con `fuente_id` y `razon`, una entrada por cada fuente del PLAN que no produjo registros (por estado, por falta de credencial, o por error durante la extracción).
- **`cobertura_pct`** — número entre 0 y 100 calculado honestamente (ver sección de cobertura).
- **`datos_cubiertos`** — unión de los `datos_cubiertos` de todos los registros exitosos.
- **`datos_faltantes`** — diferencia entre `datos_requeridos` (del PLAN) y `datos_cubiertos`.
- **`requiere_revision_humana`** — booleano propagado desde el PLAN, no decidido por el extractor.
- **`extraido_en`** — timestamp ISO 8601 del momento en que el orquestador completó la ejecución completa.

### `Adaptador`

Un Protocol que define el contrato que cada implementación de adaptador debe cumplir. Un adaptador expone un único método:

```
obtener(fuente, credenciales) → list[Registro]
```

El método recibe el objeto de fuente del PLAN (con su id, metodo_acceso, metadatos y datos_que_cubre) y el diccionario de credenciales disponibles. Devuelve una lista de `Registro` sin `registro_id` (el orquestador los sella). Si la fuente no produce registros por cualquier motivo, el adaptador puede devolver lista vacía o lanzar excepción — ambos casos resultan en la fuente siendo registrada en `fuentes_omitidas`.

---

## Despacho por método de acceso — los 5 adaptadores

El orquestador mapea el campo `metodo_acceso` de cada fuente del PLAN a su adaptador correspondiente. El despacho es exacto — no hay fallback entre adaptadores, no hay inferencia del método correcto. Si el método de una fuente no coincide con ninguno de los cinco reconocidos, la fuente se omite con razón `"metodo_acceso_desconocido"`.

### `feed` → adaptador_feed

Lee el feed RSS o Atom desde la URL declarada en los metadatos de la fuente. Parsea todas las entradas disponibles. Cada entrada del feed se convierte en un `Registro` independiente, con `contenido` tomado del campo `summary` o `content` de la entrada, y `metadatos` incluyendo la URL del ítem y su guid. Si el feed no está disponible o la URL no responde con XML parseable, la fuente va a `fuentes_omitidas`.

### `api` → adaptador_api

Llama al endpoint REST o GraphQL declarado en los metadatos de la fuente. Los parámetros de la llamada (headers de autenticación, query params, body) se construyen desde los metadatos de la fuente y el diccionario de credenciales. La respuesta debe ser JSON. El adaptador parsea la respuesta y convierte cada elemento en un `Registro`. Si la respuesta no es 2xx o no es JSON parseable, la fuente va a `fuentes_omitidas` con el código de error y el cuerpo truncado como razón.

### `web` → adaptador_web

Antes de hacer cualquier fetch, verifica `robots.txt` del dominio. Si las reglas de robots.txt bloquean el user-agent del adaptador para la URL declarada, la fuente va a `fuentes_omitidas` con razón `"bloqueado_por_robots_txt"` — sin excepción, sin override. Solo fetcha la página exacta declarada en los metadatos; no sigue enlaces, no descubre páginas adicionales, no crawlea el sitio. El contenido extraído es el texto visible de la página, sin HTML. El adaptador_web no hace decisiones sobre qué parte del contenido es relevante — extrae el texto completo y lo entrega como un único `Registro`. La relevancia la evalúa un paso posterior del pipeline.

### `archivo_cliente` → adaptador_archivo

Lee el archivo desde el path declarado en los metadatos de la fuente. Antes de abrir cualquier path, verifica que el path resuelto (después de expandir `..`, symlinks y caracteres especiales) esté contenido dentro de `FORGE_UPLOAD_ROOT`. Si el path resuelto sale de ese directorio, la fuente se omite con razón `"path_traversal_detectado"` y se registra una advertencia de seguridad. Esta defensa es incondicional — no hay modo de bypass.

Formatos soportados: CSV y TSV (cada fila es un `Registro`), JSON (si es array, cada elemento es un `Registro`; si es objeto, el objeto completo es un `Registro`), y texto plano (el contenido completo como un único `Registro`). Si el archivo no existe, no es legible o el formato no es uno de los cuatro soportados, la fuente va a `fuentes_omitidas`.

### `dataset_abierto` → adaptador_dataset

Descarga el archivo desde la URL pública declarada en los metadatos de la fuente. Solo acepta URLs con esquema `https`. Soporta CSV y JSON como formatos de descarga. Aplica las mismas reglas de parseo que adaptador_archivo para convertir el contenido en `Registro`. Si la URL no responde, el archivo descargado no está en un formato soportado, o el esquema no es `https`, la fuente va a `fuentes_omitidas`.

---

## Fuentes omitidas — cuándo y por qué

Una fuente omitida no es un fallo del skill — es información honesta sobre el límite de lo que fue posible obtener. El `ResultadoExtraccion` siempre documenta explícitamente las fuentes omitidas y la razón de cada omisión. Las cuatro causas reconocidas:

**Estado `descartada` o `dudosa`** — el PLAN ya indicó que estas fuentes no deben usarse. El orquestador las omite sin intentar extracción y registra `"estado_no_extraible"` como razón. No es un error — es seguir el criterio que forge-sources ya aplicó.

**Estado `condicional` sin credencial disponible** — la fuente requiere credencial que no está en el diccionario de credenciales recibido por el orquestador. Se omite con razón `"credencial_no_disponible"` y se incluye qué credencial falta. Esto permite al usuario saber exactamente qué necesita proveer para recuperar esa fuente en una re-ejecución.

**Excepción de red o parseo durante extracción** — el adaptador lanzó excepción al intentar obtener la fuente. El error se captura, se registra el tipo de excepción y su mensaje truncado en `fuentes_omitidas`, y el orquestador continúa con las fuentes restantes. Una falla en una fuente no interrumpe la extracción de las demás.

**Adaptador_web bloqueado por robots.txt** — caso especial del punto anterior, explicitado por su importancia operativa y legal. La razón registrada diferencia este caso de una falla de red para que el usuario sepa que no es un problema técnico sino una restricción del servidor origen.

---

## Cálculo de cobertura — la regla de honestidad

```
cobertura_pct = (datos_requeridos cubiertos por registros exitosos) / total_datos_requeridos × 100
```

Solo cuentan los datos que aparecen en `datos_cubiertos` de al menos un registro en `fuentes_usadas`. Si una fuente falló y fue a `fuentes_omitidas`, los datos que esa fuente habría cubierto no suman a la cobertura, aunque el PLAN los listara en su `datos_que_cubre`.

La cobertura se calcula desde los registros reales, no desde las declaraciones del PLAN. El orquestador construye la unión de `datos_cubiertos` de todos los registros exitosos, la intersecta con `datos_requeridos`, y divide por el total de datos requeridos. El resultado es el único número que va a `cobertura_pct`.

`validar_extraccion.py` recalcula este número de forma independiente después de la ejecución. Si el valor recalculado difiere del declarado en el resultado, hay un bug en el orquestador que debe corregirse — el validador no miente.

---

## registro_id — sellado por el orquestador

El formato `"src-N:rM"` es generado exclusivamente por el orquestador, no por los adaptadores. El flujo es:

1. El adaptador devuelve una lista de `Registro` sin `registro_id` (el campo llega vacío o ausente).
2. El orquestador itera la lista de fuentes del PLAN en orden. Para la fuente en índice N, llama al adaptador y obtiene sus registros.
3. Para cada registro devuelto, el orquestador asigna `registro_id = "src-{N}:r{M}"` donde M es el contador de registro dentro de esa fuente, empezando en 1.
4. El registro sellado se agrega a la lista de `registros` del resultado.

Esta secuencia garantiza que `registro_id` sea único dentro de una ejecución sin requerir coordinación entre adaptadores. Un adaptador que intente asignar su propio `registro_id` tendrá ese valor sobreescrito por el orquestador.

La unicidad es por ejecución, no global. Dos ejecuciones de forge-extract sobre el mismo PLAN pueden producir registros con los mismos `registro_id` si las fuentes devuelven el mismo número de registros. Para trazabilidad a largo plazo, el sistema que consume el `ResultadoExtraccion` debe combinar `registro_id` con un identificador de ejecución.

---

## correr_tuberia — el punto de extensión

`correr_tuberia(fuente, credenciales)` es la función que el orquestador llama para despachar una fuente a su adaptador. En los scripts de referencia Python, esta función lanza `NotImplementedError` — su presencia en el código de referencia es deliberada: marca exactamente el punto donde el backend TypeScript conecta la implementación real.

En el backend TypeScript, el orquestador reemplaza esta función con el dispatcher real que instancia el adaptador correcto según `fuente.metodo_acceso` y llama a su método `obtener`. La interfaz que el dispatcher debe cumplir es idéntica a la del código Python de referencia: recibe `fuente` y `credenciales`, devuelve `list[Registro]` o lanza excepción.

Este diseño permite que los scripts de referencia sean completamente funcionales como documentación ejecutable — el código compila y los tipos son verificables — sin requerir implementaciones reales de los adaptadores para correr las pruebas de contrato.

---

## requiere_revision_humana — propagación sin interpretación

Si el PLAN producido por forge-sources marcó `requiere_revision_humana: true` en alguna de sus fuentes de riesgo alto, esa bandera se propaga al `ResultadoExtraccion` sin modificación. El extractor no decide si la revisión humana es necesaria — esa decisión la tomó forge-sources cuando evaluó el riesgo de cada fuente.

La propagación es incondicional: si el PLAN la marcó, el resultado la lleva, independientemente de si esa fuente específica terminó en `fuentes_usadas` o en `fuentes_omitidas`. La bandera no dice "esta extracción fue riesgosa" — dice "el plan del que proviene esta extracción incluyó fuentes de riesgo alto que el usuario debe revisar".

El sistema que consume el `ResultadoExtraccion` es responsable de detener el pipeline y solicitar aprobación explícita antes de pasar los datos a forge-analyze o cualquier paso posterior cuando `requiere_revision_humana` es `true`.

---

## Scripts de referencia

Los scripts en `scripts/` son la especificación ejecutable del contrato. Definen los tipos, la lógica y los invariantes de forma que el código TypeScript de producción pueda verificarse contra ellos.

**`contrato.py`** — define los dataclasses `Registro` y `ResultadoExtraccion`, y el Protocol `Adaptador` con su método `obtener`. Es la fuente de verdad de los tipos. Cualquier cambio en el contrato de datos debe reflejarse primero aquí.

**`orquestador.py`** — implementa la lógica de despacho completa: itera las fuentes del PLAN, filtra por estado, llama a `correr_tuberia`, captura excepciones, sella `registro_id`, acumula registros, calcula cobertura y construye el `ResultadoExtraccion`. La función `correr_tuberia` lanza `NotImplementedError` en este archivo — es el punto de extensión para el backend.

**`validar_extraccion.py`** — recibe un `ResultadoExtraccion` serializado y los `datos_requeridos` originales. Recalcula `cobertura_pct` desde los registros del resultado, compara con el valor declarado, y reporta cualquier divergencia. No modifica el resultado — solo verifica su honestidad.

**`adaptador_feed.py`** — implementación de referencia del adaptador RSS/Atom. Parsea con `feedparser`, convierte entradas en `Registro`, maneja feeds malformados devolviendo lista vacía en lugar de lanzar excepción no capturada.

**`adaptador_api.py`** — implementación de referencia del adaptador REST. Construye la llamada HTTP desde los metadatos de la fuente, parsea la respuesta JSON, maneja errores HTTP con códigos y mensajes legibles.

**`adaptador_web.py`** — implementación de referencia del adaptador de scraping. Verifica robots.txt antes del fetch principal, extrae texto con `BeautifulSoup`, devuelve un único `Registro` por página.

**`adaptador_archivo.py`** — implementación de referencia del adaptador de archivos. Verifica confinamiento a `FORGE_UPLOAD_ROOT` antes de abrir, parsea CSV/TSV/JSON/texto, convierte cada fila u objeto en un `Registro`.

**`adaptador_dataset.py`** — implementación de referencia del adaptador de datasets públicos. Descarga con `requests` solo sobre `https`, parsea CSV o JSON, convierte en `Registro` con las mismas reglas que adaptador_archivo.
