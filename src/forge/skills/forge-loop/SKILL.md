---
name: forge-loop
description: >-
  Motor del lazo continuo del Operador Autónomo. Skill mecánico — su lógica
  corre como código determinista (no LLM). Despierta cuando el scheduler lo
  activa, ejecuta la tubería de extracción con el skill_operante actual,
  calcula la huella del resultado, detecta cambios o deterioro, decide si
  seguir operando o iniciar adaptación, y actualiza el estado del lazo en
  Postgres. No activar vía LLM — el scheduler de BullMQ lo invoca. Su
  SKILL.md es especificación de referencia y contrato para la implementación
  TypeScript.
forge_approved: false
forge_autonomy: autonomous
forge_output_format: text
forge_capabilities:
  agentic: true
  multimodal: false
  proactive: true
  dynamic_flow: false
  integrations: false
forge_capabilities_detail:
  agentic:
    can_run_unattended: true
    on_completion: notify
  proactive:
    triggers:
      - type: cron
        schedule: variable-por-lazo
        action: execute
      - type: threshold
        metric: fallos_consecutivos
        operator: ">="
        value: 3
        action: notify
forge_runtime:
  database:
    enabled: true
    type: postgresql
    purpose: >-
      almacena EstadoLazo con lock FOR UPDATE SKIP LOCKED para evitar
      ejecuciones concurrentes del mismo lazo
  code_execution:
    enabled: true
    language: python
    purpose: >-
      estado.py, motor_lazo.py y validar_estado.py — toda la lógica del
      lazo es determinista y no requiere LLM
  external_apis: []
  scheduling:
    enabled: true
  storage:
    artifacts: ephemeral
    shared: false
---

# forge-loop — Motor del Lazo Continuo

## 1. Concepto fundamental — estado en reposo, no proceso vivo

El lazo **no es un proceso que corre continuamente**. No hay un hilo, un daemon ni un contenedor dedicado por lazo. Es un registro en Postgres que el scheduler despierta en ráfagas cuando su `proxima_ejecucion` ya pasó.

Entre ráfagas no hay proceso activo. El lazo existe únicamente como datos: su estado, su historial y su configuración persisten en la base de datos, a la espera de que el siguiente tick del scheduler llegue.

Esto es deliberado y crítico para la arquitectura:

- Un servicio caído no mata lazos. Solo los retrasa hasta que el servicio sube y el scheduler retoma la consulta.
- Escalar horizontalmente el servicio API no crea lazos duplicados — el lock `FOR UPDATE SKIP LOCKED` garantiza que solo una instancia procesa cada lazo a la vez.
- El costo operativo de un lazo inactivo es cero: es una fila en una tabla.

La consecuencia práctica es que no se debe "iniciar" ni "detener" un lazo como si fuera un proceso. Se cambia su `estado_operativo` y se actualiza (o borra) su `proxima_ejecucion`. El scheduler hace el resto.

---

## 2. EstadoLazo — los campos clave del estado

El registro `LoopState` en Postgres contiene toda la información necesaria para que el scheduler y el motor puedan ejecutar, inspeccionar o pausar el lazo sin estado adicional fuera de la base de datos.

### Identidad

| Campo | Tipo | Descripción |
|---|---|---|
| `loop_id` | `uuid` | Identificador único del lazo. Lo asigna la aplicación al crear el lazo. |
| `ficha_id` | `uuid` | Referencia a la FICHA de `forge-intake` que originó este lazo. Permite trazabilidad desde el objetivo hasta la operación. |

### Temporización

| Campo | Tipo | Descripción |
|---|---|---|
| `ritmo` | `jsonb` | Objeto con tipo `'cron'` (más una expresión cron) o `'umbral'` (métrica + operador + valor). Determina cuándo y con qué frecuencia se ejecuta el lazo. |
| `ultima_ejecucion` | `timestamptz` | Timestamp ISO de la última ráfaga completada (exitosa o fallida). |
| `proxima_ejecucion` | `timestamptz` | Timestamp ISO de cuándo debe dispararse la siguiente ráfaga. El scheduler filtra por `estado_operativo = 'activo' AND proxima_ejecucion <= now()`. |

El campo `ritmo` admite dos formas:

```json
// Tipo cron — se ejecuta según una expresión cron estándar
{ "tipo": "cron", "valor": "0 */6 * * *" }

// Tipo umbral — se ejecuta cuando una métrica externa cruza un umbral
{ "tipo": "umbral", "metrica": "articulos_nuevos", "operador": ">=", "valor": 10 }
```

Para el tipo `umbral`, el scheduler evalúa la condición en cada tick; el ritmo de evaluación del propio umbral se configura por separado a nivel del scheduler global.

### Control operativo

| Campo | Tipo | Descripción |
|---|---|---|
| `estado_operativo` | `enum` | `'activo'` \| `'pausado'` \| `'adaptando'` \| `'detenido'`. |
| `pendiente_aprobacion` | `bool` | Si es `true`, el lazo no ejecuta ninguna ráfaga hasta que un humano lo apruebe explícitamente. Se activa automáticamente al entrar en `'adaptando'`. |

Transiciones válidas de `estado_operativo`:

```
activo ──────────────┐
  │  ↑               │ (deterioro detectado)
  │  │ (aprobado)    ↓
  │  └──────── adaptando
  │                  │ (fallo recurrente)
  ↓                  ↓
pausado ────────────────────→ detenido (final, no reversible)
```

`detenido` es un estado terminal. No se puede reactivar un lazo detenido; se debe crear uno nuevo.

### Ejecución y diagnóstico

| Campo | Tipo | Descripción |
|---|---|---|
| `huella_anterior` | `jsonb` | Snapshot del último resultado: `{ contenido_hash, cobertura_pct, fuentes_activas }`. Sirve para detectar cambio real vs. deterioro. |
| `skill_operante` | `jsonb` | El skill que actualmente resuelve el problema: `{ name, version, approved_at }`. |
| `fallos_consecutivos` | `int` | Contador que sube con cada excepción real. Baja a cero con cualquier ejecución exitosa. Al alcanzar `MAX_FALLOS_CONSECUTIVOS` (3), el lazo pasa a `'pausado'`. |
| `ultima_anomalia` | `jsonb` | Registro del último error o anomalía detectada: timestamp, tipo, mensaje, contexto. |

### Política de adaptación

| Campo | Tipo | Descripción |
|---|---|---|
| `politica_adaptacion` | `jsonb` | Reglas que gobiernan cuándo y cómo el lazo puede solicitar adaptación. Ver detalle abajo. |
| `cooldown_adaptacion_hasta` | `timestamptz` | Si `now() < cooldown_adaptacion_hasta`, no se inicia adaptación aunque se detecte deterioro. Evita adaptaciones en cascada. |
| `adaptaciones_en_periodo` | `jsonb` | `{ periodo_inicio, count }` — techo anti-hiperactividad: si `count >= max_adaptaciones_por_periodo` en el período, el lazo se pausa. |

Estructura de `politica_adaptacion`:

```json
{
  "adaptar_si": ["cobertura_cae_bajo_umbral", "formato_incompatible", "skill_no_produce_resultado"],
  "no_adaptar_si": ["fuente_temporalmente_no_disponible", "resultado_vacio_esperado"],
  "max_adaptaciones_por_periodo": 2,
  "periodo_horas": 72,
  "extraccion_vacia_es_fallo": false
}
```

---

## 3. La huella — detección de cambio real

La huella (`huella_anterior`) almacena tres dimensiones del último resultado:

```typescript
interface Huella {
  contenido_hash: string;    // SHA-256 del contenido procesado, normalizado
  cobertura_pct: number;     // Porcentaje de fuentes que respondieron correctamente (0–100)
  fuentes_activas: string[]; // Lista ordenada de identificadores de fuentes que entregaron datos
}
```

Usar solo el hash del contenido no es suficiente. Considérese este escenario: una fuente muere silenciosamente y otra la reemplaza con contenido equivalente. El hash podría ser idéntico, pero la cobertura cayó del 90% al 40% y el conjunto de fuentes activas cambió. Una huella unidimensional no detectaría que la arquitectura de extracción se está degradando.

Al combinar las tres dimensiones se pueden clasificar los cambios:

| Situación | Hash | Cobertura | Fuentes activas | Interpretación |
|---|---|---|---|---|
| El mundo cambió normalmente | Distinto | Estable | Estables | Cambio normal — operar |
| Una fuente murió, datos equivalentes | Igual o distinto | Cae | Cambia | Deterioro potencial |
| Cobertura colapsa | Distinto | Cae drásticamente | Reducidas | Deterioro confirmado |
| Sin cambio real | Igual | Igual | Iguales | Tick vacío esperado |
| Extracción vacía | — | 0% | Ninguna | Ver `extraccion_vacia_es_fallo` |

El umbral de "caída drástica" de cobertura es configurable por lazo, con un valor predeterminado del 30% de caída relativa respecto a la huella anterior.

---

## 4. Ciclo de una ráfaga — lógica de `ejecutar_rafaga`

Una ráfaga es la unidad atómica de ejecución del lazo. Cada ráfaga procesa exactamente un ciclo completo y actualiza el estado antes de terminar.

### (a) Verificación de precondiciones

Antes de hacer cualquier trabajo:

1. Leer el registro `LoopState` con `SELECT … FOR UPDATE SKIP LOCKED`. Si el registro está bloqueado, salir silenciosamente — otra instancia ya está procesando este lazo.
2. Verificar `estado_operativo == 'activo'`. Si es `'pausado'`, `'adaptando'` o `'detenido'`, salir sin ejecutar.
3. Verificar `pendiente_aprobacion == false`. Si es `true`, salir sin ejecutar y registrar en el log que el lazo está esperando aprobación humana.

### (b) Ejecución de la tubería de extracción

Invocar el orquestador de `forge-extract` con el `skill_operante` actual como contexto de ejecución. El resultado debe ser normalizable a la estructura de huella.

Esta llamada es la única parte del ciclo que puede tardar significativamente. El lock de Postgres se mantiene durante toda la ráfaga; el TTL del lock cubre el peor caso de latencia de extracción (configurado en 90s, igual que el mutex de conversación del worker principal).

### (c) Manejo de excepciones

Si la ejecución de la tubería lanza una excepción (error de red, timeout, error interno del skill):

1. Incrementar `fallos_consecutivos` en 1.
2. Actualizar `ultima_anomalia` con timestamp, tipo de excepción y mensaje (sin datos sensibles).
3. Evaluar si `fallos_consecutivos >= MAX_FALLOS_CONSECUTIVOS` (3 por defecto).
   - Si sí: cambiar `estado_operativo` a `'pausado'`, emitir notificación al sistema.
   - Si no: continuar — el scheduler reintentará en la próxima `proxima_ejecucion`.
4. Actualizar `ultima_ejecucion` y calcular `proxima_ejecucion`.
5. Liberar el lock y terminar.

No toda excepción es deterioro del skill. Una fuente temporalmente no disponible es un fallo transitorio; `fallos_consecutivos` maneja la acumulación.

### (d) Extracción vacía

Si la extracción devuelve un resultado vacío (cero elementos, cobertura 0%):

- Consultar `politica_adaptacion.extraccion_vacia_es_fallo`.
  - Si `true`: tratar como fallo (paso c, sin incrementar `fallos_consecutivos` de la misma forma que una excepción — es un resultado, no una excepción, pero cuenta como señal negativa).
  - Si `false`: registrar como evento normal. Esto es esperado en lazos de monitoreo de ausencia, donde "no hay nada nuevo" es el resultado correcto. Resetear `fallos_consecutivos`, actualizar estado normalmente.

### (e) Cálculo y comparación de huella

Con el resultado disponible, calcular la huella nueva:

```python
def _huella(resultado) -> Huella:
    contenido_norm = normalizar(resultado.items)          # orden canónico, sin timestamps volátiles
    return Huella(
        contenido_hash=sha256(json.dumps(contenido_norm, sort_keys=True)),
        cobertura_pct=resultado.fuentes_respondieron / resultado.fuentes_intentadas * 100,
        fuentes_activas=sorted(resultado.fuentes_activas),
    )
```

Comparar con `huella_anterior` usando las tres dimensiones.

### (f) Cambio normal — actualizar y continuar

Si la comparación de huella indica cambio normal (datos distintos, cobertura estable, fuentes estables):

1. Resetear `fallos_consecutivos` a 0.
2. Actualizar `huella_anterior` con la huella nueva.
3. Registrar el resultado en el historial de ejecuciones.
4. Actualizar `ultima_ejecucion` y calcular `proxima_ejecucion`.

### (g) Deterioro detectado — activar lógica de adaptación

Si la comparación indica deterioro (ver sección 5), delegar a la lógica de adaptación (sección 6).

### (h) Actualización de temporización

Al final de toda ráfaga — exitosa, fallida o vacía — actualizar:

- `ultima_ejecucion = now()`
- `proxima_ejecucion = calcular_proxima(ritmo, now())`

Para tipo `cron`, usar la expresión cron para calcular la siguiente ocurrencia después de `now()`. Para tipo `umbral`, la `proxima_ejecucion` se establece al próximo tick del scheduler — el scheduler evalúa la condición en cada tick y decide si encolar la ráfaga.

---

## 5. Distinguir cambio normal de deterioro del skill

Esta es la distinción central del motor. Un lazo que no puede distinguirla o adapta compulsivamente o ignora degradación real.

### Cambio normal

El mundo exterior cambió. Nuevas noticias, nuevos registros en una base de datos, nuevos artículos publicados. El skill procesa esos datos correctamente y produce un resultado coherente con el objetivo. La cobertura se mantiene en el rango esperado y las fuentes activas son las mismas (o cambian dentro de la varianza normal).

Señales de cambio normal:
- Hash del contenido distinto, pero estructura del resultado idéntica a la esperada.
- Cobertura dentro del ±10% de la huella anterior.
- Fuentes activas son el mismo conjunto o un subconjunto mínimamente distinto.
- El resultado, aunque diferente, es procesable y coherente con el objetivo de la FICHA.

### Deterioro del skill

El problema está en la capacidad de procesamiento, no en los datos. El skill ya no puede servir el objetivo correctamente.

Señales de deterioro:
- **Colapso de cobertura**: la cobertura cae más del 30% relativo respecto a la huella anterior de forma sostenida (no solo en una ráfaga).
- **Formato incompatible**: el skill devuelve errores de parseo, campos ausentes o datos estructuralmente incoherentes — indica que la fuente cambió su formato y el skill no se adaptó.
- **Resultado incoherente con el objetivo**: el contenido procesado no guarda relación semántica con el objetivo de la FICHA (detectable via comparación con embeddings del objetivo, si están disponibles).
- **Skill no produce resultado**: la tubería completa sin excepción pero devuelve cero items de forma repetida cuando `extraccion_vacia_es_fallo = true`.
- **Fuentes activas colapsaron**: el conjunto de fuentes activas se redujo a menos del 50% del conjunto histórico de forma sostenida.

La diferencia operativa: en cambio normal, no se hace nada excepto registrar. En deterioro, se evalúa la política de adaptación y potencialmente se solicita un nuevo skill.

---

## 6. Adaptación — cuándo y cómo

La adaptación no es automática e irrestricta. Está gobernada por tres frenos independientes que deben verificarse en orden antes de proceder.

### Paso 1 — Verificar cooldown

Consultar `cooldown_adaptacion_hasta`. Si `now() < cooldown_adaptacion_hasta`:

- No adaptar.
- Registrar en `ultima_anomalia` que se detectó deterioro pero está en período de enfriamiento.
- Continuar operando con el skill actual.
- El cooldown existe para evitar que una fuente inestable genere adaptaciones en cascada. Una fuente que fluctúa cada hora no debe disparar un nuevo skill cada hora.

### Paso 2 — Verificar techo del período

Consultar `adaptaciones_en_periodo`. Si `count >= max_adaptaciones_por_periodo` dentro del `periodo_horas`:

- No adaptar.
- Cambiar `estado_operativo` a `'pausado'`.
- Registrar diagnóstico: `"adapta_sin_estabilizarse"` — el lazo solicitó adaptación múltiples veces en el período sin que ninguna estabilizara la operación. Requiere intervención humana para revisar el objetivo de la FICHA o la disponibilidad de las fuentes.
- Emitir notificación al sistema.

Este freno es crítico para la seguridad operativa. Sin él, un lazo en un entorno degradado podría consumir todos los recursos de generación de skills en intentos repetidos de adaptación.

### Paso 3 — Iniciar adaptación

Si ambos frenos permiten proceder:

1. Cambiar `estado_operativo` a `'adaptando'`.
2. Establecer `pendiente_aprobacion = true`.
3. Actualizar `cooldown_adaptacion_hasta = now() + cooldown_horas` (configurable, predeterminado 24h).
4. Incrementar `adaptaciones_en_periodo.count`. Si el período venció, reiniciar: `{ periodo_inicio: now(), count: 1 }`.
5. Encolar un mensaje al sistema con el estado actual del lazo como contexto completo. El mensaje instruye al orquestador a disparar `forge-analyze` → `forge-factory` para generar un candidato de skill alternativo.
6. El lazo permanece en `'adaptando'` con `pendiente_aprobacion = true` hasta que:
   - Un humano aprueba el nuevo skill → se actualiza `skill_operante`, se cambia a `'activo'`, se limpia `pendiente_aprobacion`.
   - Un humano rechaza o pausa manualmente → se cambia a `'pausado'`.

El lazo no se ejecuta mientras `pendiente_aprobacion = true`. No hay riesgo de que el skill degradado siga produciendo resultados erróneos mientras se prepara el reemplazo.

---

## 7. Lock — acceso concurrente

Todo acceso de escritura al registro `LoopState` debe usar:

```sql
SELECT * FROM loop_states
WHERE loop_id = $1
FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` es la clave: si el registro está bloqueado por otra instancia (porque otra ráfaga del mismo lazo está procesando), la consulta devuelve cero filas en lugar de esperar. El código que recibe cero filas simplemente sale sin ejecutar — la ráfaga se omite silenciosamente.

El scheduler reintentará en el siguiente tick. No se necesita ningún mecanismo adicional de deduplicación: el lock de base de datos es suficiente.

Esto implica que los workers del BullMQ que procesan ráfagas son todos idénticos y sin estado. Se pueden escalar horizontalmente sin coordinación adicional — Postgres gestiona la exclusión mutua.

El lock se mantiene durante toda la duración de la ráfaga (incluyendo la llamada a `forge-extract`). Esto es intencional: no queremos que otra instancia lea un estado parcialmente actualizado y tome decisiones incorrectas. El TTL de 90 segundos del lock cubre el peor caso de latencia de extracción.

---

## 8. `tick_scheduler` — el coordinador

El `tick_scheduler` es un **repeatable job de BullMQ** que corre cada N minutos (configurable globalmente, predeterminado 1 minuto). Es liviano: solo consulta y encola.

### Lógica del tick

```python
def tick_scheduler(ahora: datetime, almacen: AlmacenEstado, cola: Queue):
    lazos_listos = almacen.consultar_lazos_listos(ahora)
    # consultar_lazos_listos filtra por:
    #   estado_operativo = 'activo'
    #   pendiente_aprobacion = false
    #   proxima_ejecucion <= ahora

    for lazo in lazos_listos:
        cola.encolar_rafaga(lazo.loop_id)
        # El job encolado tiene:
        #   - jobId: f"rafaga-{loop_id}" (deduplicación por BullMQ)
        #   - removeOnComplete: true
        #   - attempts: 3 con backoff exponencial
```

El `tick_scheduler` no ejecuta ráfagas directamente. Solo encola jobs. Esto es fundamental:

- **Desacoplamiento**: el scheduler no bloquea esperando que termine la extracción.
- **Retry nativo**: si una ráfaga falla, BullMQ la reintenta automáticamente sin que el scheduler lo sepa.
- **DLQ**: ráfagas agotadas van al DLQ de BullMQ para inspección manual, igual que los mensajes de conversación.
- **Paralelismo controlado**: múltiples ráfagas de lazos distintos corren en paralelo; el lock de Postgres evita que el mismo lazo corra dos veces.

La deduplicación por `jobId = f"rafaga-{loop_id}"` previene que el scheduler encole dos ráfagas del mismo lazo si el tick anterior encoló una que todavía no fue procesada. BullMQ silencia la segunda inserción si el job ya existe en la cola.

---

## 9. Scripts de referencia

Los scripts en `scripts/` implementan la lógica completa en Python como referencia determinista. Son independientes del runtime TypeScript y sirven para:

- Validar la lógica del motor antes de la implementación TypeScript.
- Probar casos borde (cooldown, techo de período, extracción vacía) sin infraestructura.
- Documentar el contrato de comportamiento con ejemplos ejecutables.

### `scripts/estado.py`

Define las dataclasses del dominio y los protocolos de acceso a datos.

Contenido principal:
- `dataclass Huella`: `contenido_hash: str`, `cobertura_pct: float`, `fuentes_activas: list[str]`.
- `dataclass Ritmo`: `tipo: Literal['cron', 'umbral']`, `valor: str | None`, `metrica: str | None`, `operador: str | None`, `umbral_valor: float | None`.
- `dataclass PoliticaAdaptacion`: todos los campos de la política con valores predeterminados razonables.
- `dataclass AdaptacionesPeriodo`: `periodo_inicio: datetime`, `count: int`.
- `dataclass EstadoLazo`: todos los campos del registro, con tipos Python y valores predeterminados.
- `Protocol AlmacenEstado`: interfaz mínima que la implementación TypeScript debe satisfacer — `leer_con_lock`, `guardar`, `consultar_lazos_listos`.
- `class AlmacenMemoria(AlmacenEstado)`: implementación en memoria para tests, sin dependencias externas.

### `scripts/motor_lazo.py`

Implementa la lógica central del motor.

Funciones principales:
- `ejecutar_rafaga(loop_id, almacen, extractor, ahora) -> ResultadoRafaga`: implementación completa del ciclo descrito en la sección 4, incluyendo todos los pasos de verificación, ejecución, comparación de huella y actualización de estado.
- `tick_scheduler(ahora, almacen, cola) -> list[str]`: consulta lazos listos y devuelve lista de `loop_id` encolados (la cola real es un parámetro inyectado para testabilidad).
- `_huella(resultado) -> Huella`: función pura que calcula la huella de un resultado de extracción.
- `_detectar_deterioro(huella_nueva, huella_anterior, politica) -> bool | str`: retorna `False` si no hay deterioro, o una cadena con el tipo de deterioro detectado si lo hay.
- `_puede_adaptar(estado, ahora) -> tuple[bool, str]`: evalúa los dos frenos (cooldown y techo de período) y retorna si se puede adaptar y por qué no si no se puede.
- `_iniciar_adaptacion(estado, tipo_deterioro, ahora) -> EstadoLazo`: retorna el estado actualizado con la solicitud de adaptación.

### `scripts/validar_estado.py`

Valida la coherencia interna de un `EstadoLazo`.

Invariantes verificados:
- Si `estado_operativo == 'adaptando'` entonces `pendiente_aprobacion == true`. Un lazo en adaptación sin aprobación pendiente es un estado corrupto.
- Si `estado_operativo == 'activo'` y `ritmo.tipo == 'cron'` entonces `proxima_ejecucion is not None`. Un lazo activo con cron sin próxima ejecución nunca será procesado.
- Si `estado_operativo == 'detenido'` entonces `proxima_ejecucion is None`. Un lazo detenido no debe tener ejecuciones programadas.
- `fallos_consecutivos >= 0` siempre.
- `adaptaciones_en_periodo.count >= 0` siempre.
- Si `adaptaciones_en_periodo.count > 0` entonces `adaptaciones_en_periodo.periodo_inicio is not None`.
- `cooldown_adaptacion_hasta` puede ser `None` (sin cooldown activo) o un timestamp en cualquier relación con `now()`.

La función principal `validar(estado: EstadoLazo) -> list[str]` retorna una lista de mensajes de error. Lista vacía significa estado coherente. Se debe llamar antes de guardar cualquier `EstadoLazo` modificado en producción.
