"""
Motor del lazo continuo forge-loop.

Implementa la lógica de ejecución en ráfagas, detección de cambios,
frenos anti-hiperactividad y coordinación con el scheduler.

Punto de extensión principal: `correr_tuberia` debe ser reemplazado
por el backend TypeScript con la llamada real al orquestador de forge-extract.

Frenos anti-hiperactividad implementados:
  1. cooldown_adaptacion: si ahora < cooldown_hasta, no adaptar.
  2. techo por período: si adaptaciones_en_periodo.count >= max, pausar.
  3. MAX_FALLOS_CONSECUTIVOS: si fallos >= 3, pausar.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from .estado import (
    AlmacenEstado,
    EntradaHistorial,
    EstadoLazo,
    Huella,
)

MAX_FALLOS_CONSECUTIVOS = 3

# El backend TypeScript conecta aquí el orquestador real de forge-extract.
# Firma: correr_tuberia(loop_id, ficha_id, org_id) -> ResultadoExtraccion (dict)
_correr_tuberia: Callable[[str, str, str], dict] = None  # type: ignore[assignment]


def configurar_tuberia(fn: Callable[[str, str, str], dict]) -> None:
    """El backend llama esto una vez al inicializar, conectando el orquestador real."""
    global _correr_tuberia
    _correr_tuberia = fn


# ───────────────────────────────────────────────
# Ejecución de ráfaga
# ───────────────────────────────────────────────

def ejecutar_rafaga(loop_id: str, almacen: AlmacenEstado) -> dict:
    """
    Ejecuta una ráfaga del lazo. Carga el estado con lock, procesa y libera.

    Retorna un dict con:
      {ejecutado: bool, estado_resultante: str, evento: str, detalle: str}

    Si el lazo está bloqueado por otra instancia → {ejecutado: False, ...}.
    Si está inactivo o pendiente aprobación → {ejecutado: False, ...}.
    """
    estado = almacen.cargar_con_lock(loop_id)
    if estado is None:
        return {"ejecutado": False, "evento": "bloqueado", "detalle": "lazo bloqueado por otra instancia"}

    try:
        resultado = _procesar_rafaga(estado)
    finally:
        almacen.guardar_y_liberar(estado)

    return resultado


def _procesar_rafaga(estado: EstadoLazo) -> dict:
    """Lógica interna de la ráfaga. Modifica el estado IN-PLACE."""

    # Guard: solo ejecutar si activo y sin aprobación pendiente
    if estado.estado_operativo != "activo":
        return {
            "ejecutado": False,
            "evento": "omitido",
            "detalle": f"estado_operativo='{estado.estado_operativo}' — no activo",
        }
    if estado.pendiente_aprobacion:
        return {
            "ejecutado": False,
            "evento": "omitido",
            "detalle": "pendiente_aprobacion=true — esperando aprobación humana",
        }

    ahora = _ahora()

    # Correr tubería de extracción
    try:
        if _correr_tuberia is None:
            raise NotImplementedError(
                "La tubería no está configurada. El backend debe llamar configurar_tuberia() "
                "antes de ejecutar ráfagas."
            )
        resultado_extraccion = _correr_tuberia(estado.loop_id, estado.ficha_id, estado.org_id)
    except Exception as exc:
        return _manejar_excepcion(estado, ahora, str(exc))

    # Verificar extracción vacía
    registros = resultado_extraccion.get("registros", [])
    es_vacia = len(registros) == 0

    if es_vacia:
        politica = estado.politica_adaptacion
        if politica.extraccion_vacia_es_fallo:
            return _manejar_excepcion(
                estado, ahora, "extracción devolvió 0 registros (política: es fallo)"
            )
        else:
            # Extracción vacía esperada — registrar como evento normal
            _registrar_evento(estado, ahora, "extraccion_vacia", "sin registros (esperado por política)")
            _actualizar_temporalizacion(estado, ahora)
            estado.ejecuciones_totales += 1
            return {
                "ejecutado": True,
                "evento": "extraccion_vacia_ok",
                "detalle": "sin registros — esperado por política de monitoreo de ausencia",
            }

    # Calcular huella del resultado
    huella_nueva = _calcular_huella(resultado_extraccion)
    huella_anterior = estado.huella_anterior

    # Resetear fallos consecutivos — ejecución exitosa
    estado.fallos_consecutivos = 0
    estado.ejecuciones_totales += 1
    estado.ultima_anomalia = None

    # Detectar deterioro vs cambio normal
    deterioro = _detectar_deterioro(huella_anterior, huella_nueva, resultado_extraccion)

    if deterioro:
        evento = _intentar_adaptacion(estado, ahora, deterioro)
    else:
        # Cambio normal — el mundo cambió, el skill lo maneja correctamente
        estado.huella_anterior = huella_nueva
        _registrar_evento(estado, ahora, "ejecucion_ok", f"{len(registros)} registros obtenidos")
        _actualizar_temporalizacion(estado, ahora)
        evento = {
            "ejecutado": True,
            "evento": "ejecucion_ok",
            "detalle": f"{len(registros)} registros procesados",
        }

    return evento


def _manejar_excepcion(estado: EstadoLazo, ahora: datetime, detalle: str) -> dict:
    """Incrementa fallos, pausa si supera el máximo."""
    estado.fallos_consecutivos += 1
    estado.ultima_anomalia = {"tipo": "excepcion", "detalle": detalle, "ts": _iso(ahora)}
    _registrar_evento(estado, ahora, "fallo", detalle)

    if estado.fallos_consecutivos >= MAX_FALLOS_CONSECUTIVOS:
        estado.estado_operativo = "pausado"
        _registrar_evento(
            estado, ahora, "pausa_por_fallos",
            f"alcanzó {MAX_FALLOS_CONSECUTIVOS} fallos consecutivos"
        )
        return {
            "ejecutado": True,
            "evento": "pausa_por_fallos",
            "detalle": f"lazo pausado tras {MAX_FALLOS_CONSECUTIVOS} fallos: {detalle}",
        }

    _actualizar_temporalizacion(estado, ahora)
    return {
        "ejecutado": True,
        "evento": "fallo",
        "detalle": detalle,
    }


def _intentar_adaptacion(estado: EstadoLazo, ahora: datetime, razon: str) -> dict:
    """Evalúa si puede adaptar; si no, registra freno."""
    politica = estado.politica_adaptacion

    # Freno 1: cooldown
    if estado.cooldown_adaptacion_hasta and ahora < estado.cooldown_adaptacion_hasta:
        _registrar_evento(estado, ahora, "adaptacion_frenada_cooldown", razon)
        _actualizar_temporalizacion(estado, ahora)
        return {"ejecutado": True, "evento": "adaptacion_frenada_cooldown", "detalle": razon}

    # Freno 2: techo del período
    conteo = _actualizar_conteo_periodo(estado, ahora, politica)
    if conteo > politica.max_adaptaciones_por_periodo:
        estado.estado_operativo = "pausado"
        diag = "adapta_sin_estabilizarse"
        _registrar_evento(estado, ahora, "pausa_por_adaptaciones", diag)
        return {
            "ejecutado": True,
            "evento": "pausa_por_adaptaciones",
            "detalle": f"superó {politica.max_adaptaciones_por_periodo} adaptaciones en {politica.periodo_horas}h: {diag}",
        }

    # Puede adaptar
    estado.estado_operativo = "adaptando"
    estado.pendiente_aprobacion = True
    estado.ultima_anomalia = {"tipo": "deterioro", "detalle": razon, "ts": _iso(ahora)}
    estado.cooldown_adaptacion_hasta = ahora + timedelta(hours=politica.periodo_horas // 4)
    _registrar_evento(estado, ahora, "adaptacion_iniciada", razon)

    return {
        "ejecutado": True,
        "evento": "adaptacion_iniciada",
        "detalle": f"deterioro detectado — esperando forge-analyze+factory: {razon}",
    }


# ───────────────────────────────────────────────
# Scheduler
# ───────────────────────────────────────────────

def tick_scheduler(almacen: AlmacenEstado) -> list[str]:
    """
    Lista los loop_ids de lazos activos que deben ejecutarse ahora.

    El backend (BullMQ repeatable job) llama esto periódicamente y encola
    un job por cada loop_id devuelto. El job llama ejecutar_rafaga().
    """
    return almacen.listar_pendientes()


# ───────────────────────────────────────────────
# Cálculo de huella
# ───────────────────────────────────────────────

def _calcular_huella(resultado: dict) -> Huella:
    """
    La huella incluye hash del contenido + cobertura + fuentes activas.
    Solo hashear contenido no detectaría que una fuente murió aunque
    el contenido siga siendo el mismo (datos cacheados, etc.).
    """
    registros = resultado.get("registros", [])
    contenidos = [str(r.get("contenido", "")) for r in registros]
    contenido_concat = "\n---\n".join(sorted(contenidos))
    contenido_hash = hashlib.sha256(contenido_concat.encode("utf-8")).hexdigest()[:16]

    cobertura = float(resultado.get("cobertura_pct", 0.0))
    fuentes = sorted(set(r.get("fuente", "") for r in registros if r.get("fuente")))

    return Huella(
        contenido_hash=contenido_hash,
        cobertura_pct=cobertura,
        fuentes_activas=fuentes,
    )


def _detectar_deterioro(
    anterior: Optional[Huella], nueva: Huella, resultado: dict
) -> str:
    """
    Detecta si hay deterioro del skill_operante vs cambio normal del mundo.
    Retorna string con razón del deterioro, o "" si es cambio normal.

    Deterioro (el skill ya no sirve): cobertura cayó drásticamente,
    fuentes activas menguaron significativamente.
    Cambio normal (el mundo cambió): hash diferente pero cobertura similar,
    fuentes estables.
    """
    if anterior is None:
        return ""  # Primera ejecución — sin baseline para comparar

    # Caída de cobertura > 30 puntos porcentuales
    if anterior.cobertura_pct > 0 and nueva.cobertura_pct < anterior.cobertura_pct - 30:
        return (
            f"cobertura cayó de {anterior.cobertura_pct:.1f}% a {nueva.cobertura_pct:.1f}% "
            f"(caída de {anterior.cobertura_pct - nueva.cobertura_pct:.1f} puntos)"
        )

    # Todas las fuentes activas murieron
    if anterior.fuentes_activas and not nueva.fuentes_activas:
        return f"todas las fuentes activas dejaron de responder: {anterior.fuentes_activas}"

    # Más del 50% de las fuentes activas desaparecieron
    if anterior.fuentes_activas:
        fuentes_perdidas = set(anterior.fuentes_activas) - set(nueva.fuentes_activas)
        pct_perdidas = len(fuentes_perdidas) / len(anterior.fuentes_activas)
        if pct_perdidas > 0.5:
            return f"perdió más del 50% de las fuentes activas: {sorted(fuentes_perdidas)}"

    return ""  # Cambio normal


# ───────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────

def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _registrar_evento(estado: EstadoLazo, ts: datetime, evento: str, detalle: str) -> None:
    entrada = EntradaHistorial(ts=_iso(ts), evento=evento, detalle=detalle)
    estado.historial.append(entrada)
    # Mantener historial acotado (los últimos 100 eventos)
    if len(estado.historial) > 100:
        estado.historial = estado.historial[-100:]


def _actualizar_temporalizacion(estado: EstadoLazo, ahora: datetime) -> None:
    """Actualiza ultima_ejecucion y calcula proxima_ejecucion según el ritmo."""
    estado.ultima_ejecucion = ahora

    ritmo = estado.ritmo
    if ritmo.tipo == "cron":
        # Para cron real se necesita un parser de expresiones cron.
        # El backend TypeScript usa node-cron para esto.
        # Aquí marcamos proxima_ejecucion como None para que el scheduler
        # backend la calcule al persistir el estado.
        estado.proxima_ejecucion = None
    elif ritmo.tipo == "umbral":
        # Los lazos por umbral no tienen proxima_ejecucion fija —
        # el scheduler los evalúa en cada tick y decide.
        estado.proxima_ejecucion = None


def _actualizar_conteo_periodo(
    estado: EstadoLazo, ahora: datetime, politica
) -> int:
    """Actualiza el contador de adaptaciones del período actual. Retorna el nuevo count."""
    ap = estado.adaptaciones_en_periodo
    inicio_str = ap.get("periodo_inicio", "")
    count = ap.get("count", 0)

    if inicio_str:
        try:
            inicio = datetime.fromisoformat(inicio_str)
            if (ahora - inicio).total_seconds() > politica.periodo_horas * 3600:
                # Período expirado — resetear
                inicio_str = _iso(ahora)
                count = 0
        except ValueError:
            inicio_str = _iso(ahora)
            count = 0
    else:
        inicio_str = _iso(ahora)
        count = 0

    count += 1
    estado.adaptaciones_en_periodo = {"periodo_inicio": inicio_str, "count": count}
    return count
