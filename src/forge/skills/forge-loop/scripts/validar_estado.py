"""
Validador de coherencia para el EstadoLazo.

Verifica invariantes del estado antes de persistir o ejecutar ráfagas.
No valida el contenido de negocio — valida la coherencia estructural.

Contrato:
  validar_estado(estado: dict) -> dict
    {
      valido: bool,
      errores: list[str],
      advertencias: list[str]
    }

Acepta el estado como dict (forma serializada desde Postgres) o
como EstadoLazo (objeto Python). El validador normaliza ambos casos.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Union

try:
    from .estado import EstadoLazo
    _TIENE_CLASE = True
except ImportError:
    _TIENE_CLASE = False

ESTADOS_OPERATIVOS_VALIDOS = frozenset({"activo", "pausado", "adaptando", "detenido"})
TIPOS_RITMO_VALIDOS = frozenset({"cron", "umbral"})


def validar_estado(estado: Union[dict, "EstadoLazo"]) -> dict:
    if _TIENE_CLASE and isinstance(estado, EstadoLazo):
        d = _estado_a_dict(estado)
    elif isinstance(estado, dict):
        d = estado
    else:
        return {
            "valido": False,
            "errores": ["El estado debe ser un dict o EstadoLazo."],
            "advertencias": [],
        }

    errores: list[str] = []
    advertencias: list[str] = []

    _validar_campos_requeridos(d, errores)
    _validar_estado_operativo(d, errores, advertencias)
    _validar_ritmo(d, errores)
    _validar_timestamps(d, errores, advertencias)
    _validar_skill_operante(d, errores)
    _validar_coherencia_adaptacion(d, errores, advertencias)
    _validar_coherencia_fallos(d, errores, advertencias)
    _validar_politica_adaptacion(d, errores, advertencias)

    return {
        "valido": len(errores) == 0,
        "errores": errores,
        "advertencias": advertencias,
    }


def _estado_a_dict(estado: "EstadoLazo") -> dict:
    import dataclasses
    d = dataclasses.asdict(estado)
    # Convertir datetimes a ISO string
    for key in ("ultima_ejecucion", "proxima_ejecucion", "cooldown_adaptacion_hasta"):
        val = d.get(key)
        if isinstance(val, datetime):
            d[key] = val.isoformat()
    return d


def _validar_campos_requeridos(d: dict, errores: list) -> None:
    requeridos = ["loop_id", "ficha_id", "org_id", "ritmo", "estado_operativo", "skill_operante", "politica_adaptacion"]
    for campo in requeridos:
        if not d.get(campo):
            errores.append(f"Campo requerido ausente o vacío: '{campo}'.")


def _validar_estado_operativo(d: dict, errores: list, advertencias: list) -> None:
    eo = d.get("estado_operativo")
    if eo not in ESTADOS_OPERATIVOS_VALIDOS:
        errores.append(
            f"'estado_operativo' inválido: '{eo}'. Válidos: {sorted(ESTADOS_OPERATIVOS_VALIDOS)}."
        )
        return

    # Invariante: adaptando ⇒ pendiente_aprobacion
    if eo == "adaptando" and not d.get("pendiente_aprobacion"):
        errores.append(
            "'estado_operativo=adaptando' requiere 'pendiente_aprobacion=true'. "
            "Un lazo en adaptación siempre espera aprobación humana."
        )

    # Invariante: activo ⇒ no pendiente_aprobacion (normalmente)
    if eo == "activo" and d.get("pendiente_aprobacion"):
        advertencias.append(
            "'estado_operativo=activo' con 'pendiente_aprobacion=true' — "
            "el lazo no ejecutará hasta que se apruebe. ¿Es intencional?"
        )


def _validar_ritmo(d: dict, errores: list) -> None:
    ritmo = d.get("ritmo")
    if not isinstance(ritmo, dict):
        errores.append("'ritmo' debe ser un objeto.")
        return

    tipo = ritmo.get("tipo")
    if tipo not in TIPOS_RITMO_VALIDOS:
        errores.append(f"'ritmo.tipo' inválido: '{tipo}'. Válidos: {sorted(TIPOS_RITMO_VALIDOS)}.")
        return

    if tipo == "cron":
        if not ritmo.get("valor", "").strip():
            errores.append("'ritmo.valor' (expresión cron) es requerido cuando tipo='cron'.")
    elif tipo == "umbral":
        if not ritmo.get("metrica", "").strip():
            errores.append("'ritmo.metrica' es requerida cuando tipo='umbral'.")
        if not ritmo.get("operador", "").strip():
            errores.append("'ritmo.operador' es requerido cuando tipo='umbral'.")


def _validar_timestamps(d: dict, errores: list, advertencias: list) -> None:
    # Invariante: activo + cron ⇒ proxima_ejecucion debería estar seteada
    eo = d.get("estado_operativo")
    ritmo = d.get("ritmo") or {}

    if eo == "activo" and ritmo.get("tipo") == "cron":
        prox = d.get("proxima_ejecucion")
        if not prox:
            advertencias.append(
                "'estado_operativo=activo' con 'ritmo.tipo=cron' pero 'proxima_ejecucion' no está seteada. "
                "El scheduler no la incluirá en la lista de pendientes."
            )

    # Validar formato ISO de timestamps presentes
    for campo in ("ultima_ejecucion", "proxima_ejecucion", "cooldown_adaptacion_hasta"):
        val = d.get(campo)
        if val is not None:
            if not _es_iso_valido(val):
                errores.append(f"'{campo}' no es un timestamp ISO 8601 válido: '{val}'.")

    # Coherencia: ultima_ejecucion <= proxima_ejecucion
    ult = _parsear_ts(d.get("ultima_ejecucion"))
    prox = _parsear_ts(d.get("proxima_ejecucion"))
    if ult and prox and ult > prox:
        errores.append(
            f"'ultima_ejecucion' ({d['ultima_ejecucion']}) es posterior a 'proxima_ejecucion' "
            f"({d['proxima_ejecucion']}). El scheduler quedaría en loop inmediato."
        )


def _validar_skill_operante(d: dict, errores: list) -> None:
    so = d.get("skill_operante")
    if not isinstance(so, dict):
        errores.append("'skill_operante' debe ser un objeto.")
        return

    if not so.get("name", "").strip():
        errores.append("'skill_operante.name' (kebab-case) es requerido.")

    version = so.get("version")
    if version is None:
        errores.append("'skill_operante.version' (entero) es requerido.")
    elif not isinstance(version, int) or version < 1:
        errores.append(f"'skill_operante.version' debe ser entero >= 1, got: '{version}'.")

    approved_at = so.get("approved_at")
    if not approved_at:
        errores.append("'skill_operante.approved_at' (timestamp ISO) es requerido.")
    elif not _es_iso_valido(str(approved_at)):
        errores.append(f"'skill_operante.approved_at' no es ISO válido: '{approved_at}'.")


def _validar_coherencia_adaptacion(d: dict, errores: list, advertencias: list) -> None:
    # Si fue_adaptando recientemente, debería haber ultima_anomalia
    eo = d.get("estado_operativo")
    ua = d.get("ultima_anomalia")

    if eo == "adaptando" and not ua:
        advertencias.append(
            "'estado_operativo=adaptando' pero 'ultima_anomalia' está vacía — "
            "documentar qué deterioro disparó la adaptación."
        )


def _validar_coherencia_fallos(d: dict, errores: list, advertencias: list) -> None:
    fallos = d.get("fallos_consecutivos", 0)
    if not isinstance(fallos, int) or fallos < 0:
        errores.append("'fallos_consecutivos' debe ser entero >= 0.")
        return

    if fallos >= 3 and d.get("estado_operativo") == "activo":
        advertencias.append(
            f"'fallos_consecutivos={fallos}' con 'estado_operativo=activo' — "
            "el motor debería haber pausado el lazo. Verificar si el motor está funcionando."
        )


def _validar_politica_adaptacion(d: dict, errores: list, advertencias: list) -> None:
    pa = d.get("politica_adaptacion")
    if not isinstance(pa, dict):
        errores.append("'politica_adaptacion' debe ser un objeto.")
        return

    max_adapt = pa.get("max_adaptaciones_por_periodo")
    if max_adapt is None:
        errores.append("'politica_adaptacion.max_adaptaciones_por_periodo' es requerido.")
    elif not isinstance(max_adapt, int) or max_adapt < 1:
        errores.append("'politica_adaptacion.max_adaptaciones_por_periodo' debe ser entero >= 1.")

    periodo = pa.get("periodo_horas")
    if periodo is None:
        errores.append("'politica_adaptacion.periodo_horas' es requerido.")
    elif not isinstance(periodo, (int, float)) or periodo <= 0:
        errores.append("'politica_adaptacion.periodo_horas' debe ser número > 0.")


# ───────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────

def _es_iso_valido(val: str) -> bool:
    if not val or not isinstance(val, str):
        return False
    try:
        datetime.fromisoformat(val.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _parsear_ts(val) -> datetime | None:
    if not val or not isinstance(val, str):
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    except ValueError:
        return None
