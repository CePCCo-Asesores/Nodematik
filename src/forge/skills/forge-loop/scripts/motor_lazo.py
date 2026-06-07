#!/usr/bin/env python3
"""
Motor del lazo de operación continua (forge-loop).

Implementa las tres funciones que convierten la tubería en un operador vivo:
  - Operar: re-disparar la tubería según el ritmo; mantener el estado entre ráfagas.
  - Vigilar: comparar la ráfaga actual contra la anterior; detectar cambios y fallos.
  - Adaptar: cuando un cambio exige capacidad nueva/modificada, volver a forge-analyze.

El motor NO está corriendo todo el tiempo. Es una función que un scheduler invoca:
recibe el estado en reposo, decide qué hacer en esta ráfaga, y devuelve el estado
actualizado para persistir. Entre ráfagas, el motor no existe — solo el estado.

El motor no ejecuta la tubería directamente (eso son los cinco skills); recibe un
callable `correr_tuberia` que el backend conecta. Así el motor es lógica pura de
decisión, probable sin el backend.
"""

from __future__ import annotations
import hashlib
import json
from datetime import datetime, timezone, timedelta
from typing import Any, Callable

from estado import EstadoLazo, AlmacenEstado, MAX_HISTORIAL


# Cuántas ráfagas fallidas seguidas antes de pausar el lazo y escalar.
MAX_FALLOS_CONSECUTIVOS = 3

RITMO_A_DELTA = {
    "cada_hora": timedelta(hours=1),
    "diario": timedelta(days=1),
    "semanal": timedelta(weeks=1),
}


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(iso_str: str) -> datetime | None:
    """Parsea un timestamp ISO a datetime. Comparar datetimes es robusto; comparar
    strings ISO solo funciona si todos son homogéneos (misma zona, mismo formato),
    lo cual no se puede garantizar. Devuelve None si no parsea."""
    if not iso_str:
        return None
    try:
        return datetime.fromisoformat(iso_str)
    except (ValueError, TypeError):
        return None


def calcular_proxima(ritmo, desde: datetime) -> str | None:
    """Cuándo debe despertar la próxima ráfaga. Para umbral, no hay tiempo fijo: lo
    dispara un evento externo, así que devuelve None (el scheduler de umbral lo maneja)."""
    if not isinstance(ritmo, dict) or ritmo.get("tipo") != "cron":
        return None  # umbral u otro: sin tiempo fijo
    delta = RITMO_A_DELTA.get(ritmo.get("valor"))
    if delta is None:
        return None
    return _iso(desde + delta)


def _huella(resultado_tuberia: dict[str, Any]) -> str:
    """
    Resumen estable de una ráfaga, para comparar contra la anterior y detectar cambios.
    Se basa en los datos extraídos (registros) Y en la cobertura — no en timestamps ni
    ids, que cambian siempre. Incluir la cobertura importa: si llegan los mismos contenidos
    pero una fuente murió (cambió datos_sin_extraer / extraccion_completa), eso ES un cambio
    detectable, aunque el contenido se vea igual. Dos ráfagas con los mismos datos Y la misma
    cobertura producen la misma huella.
    """
    registros = resultado_tuberia.get("registros", [])
    contenidos = sorted(r.get("contenido", "") for r in registros)
    resumen = resultado_tuberia.get("resumen_extraccion", {})
    base = json.dumps({
        "contenidos": contenidos,
        "extraccion_completa": resumen.get("extraccion_completa"),
        "datos_sin_extraer": sorted(resumen.get("datos_sin_extraer", [])),
    }, ensure_ascii=False)
    return hashlib.sha256(base.encode("utf-8")).hexdigest()


def ejecutar_rafaga(
    estado: EstadoLazo,
    correr_tuberia: Callable[[EstadoLazo], dict[str, Any]],
    umbral_evaluador: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
) -> EstadoLazo:
    """
    Una ráfaga: el scheduler despertó este lazo. Corre la tubería, vigila qué cambió,
    decide si adaptar, y devuelve el estado actualizado.

    correr_tuberia(estado) -> resultado de la tubería (la salida de forge-extract, etc.)
       El backend conecta aquí la ejecución real de los cinco skills.
    umbral_evaluador(resultado) -> dict de anomalía si se cruzó un umbral, o None.
       Para ritmos 'umbral:*'; opcional.
    """
    # Guard: solo un lazo ACTIVO corre la tubería. Si está adaptando (esperando que el
    # gate apruebe una capacidad nueva), pausado (requiere atención) o detenido (terminal),
    # despertar no debe correr la tubería — sería desperdiciar una ráfaga sobre una solución
    # cuya capacidad está en revisión, y podría re-marcar adaptación sobre algo ya en proceso.
    if estado.estado_operativo != "activo":
        _registrar(estado, {"ts": _iso(_ahora()), "tipo": "despertar_ignorado",
                            "estado_operativo": estado.estado_operativo,
                            "nota": "el lazo no está activo; no se corre la tubería hasta que se resuelva"})
        return estado

    ahora = _ahora()
    estado.ultima_ejecucion = _iso(ahora)
    estado.ejecuciones_totales += 1

    # ── OPERAR: correr la tubería ──
    try:
        resultado = correr_tuberia(estado)
        fallo = False
        error_msg = None
    except Exception as e:
        resultado = {}
        fallo = True
        error_msg = str(e)

    # ── VIGILAR: salud y cambios ──
    # Una excepción es SIEMPRE fallo. La extracción vacía (cero fuentes ok, cero registros)
    # cuenta como fallo solo si la política del lazo lo dice — un lazo que monitorea ausencia
    # de eventos espera cero datos como resultado normal, no como falla.
    resumen = resultado.get("resumen_extraccion", {})
    vacia_es_fallo = estado.politica_adaptacion.get("extraccion_vacia_es_fallo", True)
    extraccion_vacia = (not fallo) and resumen.get("fuentes_ok", 0) == 0 and len(resultado.get("registros", [])) == 0

    if fallo or (extraccion_vacia and vacia_es_fallo):
        estado.fallos_consecutivos += 1
        detalle = error_msg if fallo else "extracción vacía: ninguna fuente devolvió datos (fuentes_ok=0)"
        evento = {"ts": _iso(ahora), "tipo": "fallo", "detalle": detalle,
                  "fallos_consecutivos": estado.fallos_consecutivos}
        if estado.fallos_consecutivos >= MAX_FALLOS_CONSECUTIVOS:
            estado.estado_operativo = "pausado"
            evento["accion"] = f"pausado tras {estado.fallos_consecutivos} fallos consecutivos; requiere atención"
        _registrar(estado, evento)
        estado.proxima_ejecucion = calcular_proxima(estado.ritmo, ahora)
        return estado

    # Ráfaga exitosa (con al menos algún dato): resetear contador de fallos.
    estado.fallos_consecutivos = 0

    huella_nueva = _huella(resultado)
    cambio = (estado.huella_anterior is not None and huella_nueva != estado.huella_anterior)
    primera_vez = estado.huella_anterior is None

    # Detección de anomalía por umbral, si aplica.
    anomalia = None
    if isinstance(estado.ritmo, dict) and estado.ritmo.get("tipo") == "umbral" and umbral_evaluador:
        anomalia = umbral_evaluador(resultado)

    # Primera ráfaga incompleta: NO se adapta (sería prematuro — no hay "antes" contra qué
    # comparar, y la solución acaba de ser aprobada con su plan; re-adaptar de inmediato
    # entraría en el loop hiperactivo que frenamos). Pero NO pasa desapercibido: se marca
    # como advertencia visible. Si sigue incompleta en ráfagas siguientes, ya habrá un
    # "antes" y la lógica normal de cobertura caída aplicará.
    if primera_vez and resumen.get("extraccion_completa") is False:
        estado.huella_anterior = huella_nueva
        _registrar(estado, {"ts": _iso(ahora), "tipo": "rafaga_ok", "cambio_detectado": False,
                            "accion": "continuar",
                            "advertencia": f"primera ráfaga con cobertura incompleta; datos sin extraer: "
                                           f"{resumen.get('datos_sin_extraer', [])}. Se opera, pero el plan "
                                           f"de fuentes podría necesitar revisión si persiste."})
        estado.proxima_ejecucion = calcular_proxima(estado.ritmo, ahora)
        return estado

    # ── ADAPTAR: decidir si este cambio exige volver a producción ──
    necesita_adaptacion, razon = _evaluar_adaptacion(resultado, cambio, anomalia, primera_vez)

    evento = {"ts": _iso(ahora), "tipo": "rafaga_ok", "cambio_detectado": cambio,
              "registros": len(resultado.get("registros", []))}

    if necesita_adaptacion:
        # Antes de adaptar, aplicar los frenos que evitan loops hiperactivos.
        permitido, motivo_freno = _puede_adaptar(estado, ahora)
        if not permitido:
            if motivo_freno == "cooldown":
                # En enfriamiento: la adaptación anterior aún no se estabiliza. No adaptar,
                # seguir operando y esperar. No es fallo — es prudencia.
                evento["accion"] = "adaptacion_en_cooldown"
                evento["razon"] = razon
            elif motivo_freno == "techo":
                # Demasiadas adaptaciones en la ventana: el problema no se resuelve adaptando.
                # Pausar y escalar, distinguible de la pausa por fallos.
                estado.estado_operativo = "pausado"
                estado.ultima_anomalia = {"razon": razon, "ts": _iso(ahora),
                                          "diagnostico": "adapta_sin_estabilizarse"}
                evento["accion"] = "pausado_por_exceso_adaptaciones"
                evento["razon"] = (f"superó {_max_adaptaciones(estado)} adaptaciones en "
                                   f"{_periodo_horas(estado)}h; requiere atención humana (adapta sin estabilizarse)")
        else:
            # Adaptación permitida: volver a producción vía forge-analyze, cruzando el gate.
            estado.estado_operativo = "adaptando"
            estado.ultima_anomalia = {"razon": razon, "ts": _iso(ahora), "anomalia": anomalia}
            estado.pendiente_aprobacion = True
            estado.adaptaciones_en_periodo.append(_iso(ahora))
            estado.cooldown_adaptacion_hasta = _iso(ahora + timedelta(hours=_cooldown_horas(estado)))
            evento["accion"] = "adaptacion_requerida"
            evento["razon"] = razon
    else:
        evento["accion"] = "continuar"

    estado.huella_anterior = huella_nueva
    _registrar(estado, evento)
    estado.proxima_ejecucion = calcular_proxima(estado.ritmo, ahora)
    return estado


def _max_adaptaciones(estado):
    return estado.politica_adaptacion.get("max_adaptaciones_por_periodo", 3)


def _periodo_horas(estado):
    return estado.politica_adaptacion.get("periodo_horas", 24)


def _cooldown_horas(estado):
    # Por defecto, el cooldown es la mitad del periodo: da margen a que la adaptación
    # se apruebe y despliegue antes de evaluar otra. Configurable por política.
    return estado.politica_adaptacion.get("cooldown_horas", max(1, _periodo_horas(estado) // 2))


def _puede_adaptar(estado, ahora):
    """
    Aplica los dos frenos contra loops hiperactivos:
      - cooldown: no adaptar si la adaptación anterior aún está en su periodo de enfriamiento.
      - techo: no adaptar si ya se alcanzó el máximo de adaptaciones en la ventana.
    Devuelve (permitido, motivo_freno). motivo_freno es 'cooldown' | 'techo' | None.
    """
    # Cooldown: comparar datetimes parseados, no strings.
    cd_hasta = _parse(estado.cooldown_adaptacion_hasta)
    if cd_hasta is not None and ahora < cd_hasta:
        return False, "cooldown"

    # Techo: contar adaptaciones dentro de la ventana (descartando las viejas).
    ventana_inicio = ahora - timedelta(hours=_periodo_horas(estado))
    recientes = []
    for ts in estado.adaptaciones_en_periodo:
        parsed = _parse(ts)
        if parsed is not None and parsed >= ventana_inicio:
            recientes.append(ts)
    estado.adaptaciones_en_periodo = recientes  # limpiar las que salieron de la ventana
    if len(recientes) >= _max_adaptaciones(estado):
        return False, "techo"

    return True, None


def _evaluar_adaptacion(resultado, cambio, anomalia, primera_vez):
    """
    Decide si una ráfaga exige volver a producción (adaptar la capacidad) o solo continuar.
    Criterio, no lista rígida: se adapta cuando el ENTORNO cambió de forma que la capacidad
    actual ya no sirve igual — no por cualquier variación de datos.

    - Una anomalía de umbral cruzado SÍ exige adaptación (es justo lo que se vigilaba).
    - Una fuente que murió (cobertura cayó respecto a antes) exige adaptación: el plan
      de fuentes quizá deba rehacerse.
    - Un cambio de datos normal (llegaron noticias nuevas) NO exige adaptación: es el
      trabajo normal del lazo, la capacidad sigue sirviendo.
    """
    if anomalia is not None:
        return True, f"umbral cruzado: {anomalia.get('descripcion', 'anomalía detectada')}"

    resumen = resultado.get("resumen_extraccion", {})
    # Fuente caída: la extracción dejó de ser completa cuando antes lo era.
    if not primera_vez and resumen.get("extraccion_completa") is False:
        sin_extraer = resumen.get("datos_sin_extraer", [])
        if sin_extraer:
            return True, f"cobertura degradada: datos sin fuente {sin_extraer}"

    # Cambio de datos normal: no adapta, continúa operando.
    return False, None


def _registrar(estado: EstadoLazo, evento: dict[str, Any]) -> None:
    estado.historial.append(evento)
    # Acotar la bitácora para que el estado no crezca sin límite.
    if len(estado.historial) > MAX_HISTORIAL:
        estado.historial = estado.historial[-MAX_HISTORIAL:]


def tick_scheduler(
    almacen: AlmacenEstado,
    correr_tuberia: Callable[[EstadoLazo], dict[str, Any]],
    umbral_evaluador=None,
) -> list[str]:
    """
    Un 'tick' del scheduler: despierta todos los lazos cuya hora ya pasó, corre su ráfaga,
    y persiste el estado actualizado. El backend llama esto periódicamente (p.ej. un
    repeatable job de BullMQ). Devuelve los loop_id que se ejecutaron.

    Este es el punto donde 'el lazo existe como estado y corre en ráfagas': el scheduler
    no mantiene procesos vivos, solo despierta estados en reposo cuando toca.
    """
    ahora_iso = _iso(_ahora())
    ejecutados = []
    for estado in almacen.listar_pendientes(ahora_iso):
        nuevo = ejecutar_rafaga(estado, correr_tuberia, umbral_evaluador)
        almacen.escribir(nuevo)
        ejecutados.append(nuevo.loop_id)
    return ejecutados
