#!/usr/bin/env python3
"""
Contrato del estado del lazo de operación continua (forge-loop).

Concepto central: un pipeline continuo NO está corriendo todo el tiempo — existe como
ESTADO EN REPOSO y corre en ráfagas cuando un trigger lo despierta. Este módulo define
qué es ese estado y la interfaz de almacenamiento que lo persiste.

El estado vive fuera del proceso (en el backend: Postgres/Redis) para que cualquier
worker pueda reanimar el lazo donde quedó, aunque el proceso que lo corría haya muerto.
Aquí el almacenamiento es una interfaz abstracta: la implementación en memoria sirve
para probar en diseño; la implementación de backend se enchufa después sin cambiar la
lógica del lazo.
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Protocol
import json


# ─── El estado en reposo de un lazo ───────────────────────────────────────────
#
# Esto es lo que persiste entre ráfagas. Un worker que despierta lee este estado,
# corre la tubería, y escribe el estado actualizado. Si el worker muere a media
# ráfaga, el estado anterior sigue intacto y otro worker lo retoma.

@dataclass
class EstadoLazo:
    loop_id: str                          # identificador único de este lazo
    ficha_id: str                         # la ficha (problema) que este lazo opera
    org_id: str                           # tenant — aislamiento multi-cliente
    ritmo: dict[str, Any]                 # cómo se dispara (ver nota de ritmo abajo)
    estado_operativo: str                 # "activo" | "pausado" | "adaptando" | "detenido"

    # Memoria entre ráfagas
    ultima_ejecucion: str | None = None   # timestamp ISO de la última ráfaga
    proxima_ejecucion: str | None = None  # cuándo debe despertar la próxima
    ejecuciones_totales: int = 0
    huella_anterior: str | None = None    # hash/resumen de la última extracción, para comparar
    # Qué capacidad opera esta solución. Objeto, no string: en un lazo vivo la VERSIÓN
    # importa — si el skill se modificó y re-aprobó, el lazo debe saber con cuál opera.
    skill_operante: dict[str, Any] | None = None  # {"name", "version", "approved_at"}

    # Salud y adaptación
    fallos_consecutivos: int = 0          # ráfagas seguidas que fallaron
    ultima_anomalia: dict[str, Any] | None = None  # qué cambió que disparó vigilancia
    pendiente_aprobacion: bool = False    # true si una adaptación espera el gate

    # Control de adaptación: evita loops hiperactivos que despiertan la FACTORY demasiado.
    politica_adaptacion: dict[str, Any] = field(default_factory=lambda: {
        "adaptar_si": ["fuente_muerta", "umbral_cruzado", "cobertura_cayo"],
        "no_adaptar_si": ["cambio_normal_de_datos"],
        "max_adaptaciones_por_periodo": 3,
        "periodo_horas": 24,
        # ¿Cero datos sin error cuenta como fallo? Default true: la mayoría de los lazos
        # esperan datos. Un lazo que monitorea AUSENCIA de eventos (p.ej. "avísame si
        # aparece una anomalía") lo pone en false: cero registros es su resultado normal,
        # no un fallo. Nota: una excepción real siempre es fallo, sin importar esta política.
        "extraccion_vacia_es_fallo": True,
    })
    cooldown_adaptacion_hasta: str | None = None   # no adaptar antes de este timestamp
    adaptaciones_en_periodo: list[str] = field(default_factory=list)  # timestamps de adaptaciones recientes

    # Auditoría
    historial: list[dict[str, Any]] = field(default_factory=list)  # bitácora de ráfagas (acotada)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "EstadoLazo":
        return EstadoLazo(**d)


ESTADOS_OPERATIVOS = {"activo", "pausado", "adaptando", "detenido"}
MAX_HISTORIAL = 50  # la bitácora se acota para no crecer sin límite

# El ritmo es un objeto estructurado, no un string, para que sea evaluable por código
# sin parsear texto. Dos formas:
#   temporal: {"tipo": "cron", "valor": "cada_hora" | "diario" | "semanal"}
#   umbral:   {"tipo": "umbral", "metrica": "...", "operador": ">" | "<" | ">=" | "<=", "valor": <num>}
TIPOS_RITMO = {"cron", "umbral"}
VALORES_CRON = {"cada_hora", "diario", "semanal"}
OPERADORES_UMBRAL = {">", "<", ">=", "<=", "=="}


def ritmo_es_temporal(ritmo: dict) -> bool:
    return isinstance(ritmo, dict) and ritmo.get("tipo") == "cron"


def ritmo_es_umbral(ritmo: dict) -> bool:
    return isinstance(ritmo, dict) and ritmo.get("tipo") == "umbral"


# ─── La interfaz de almacenamiento ────────────────────────────────────────────
#
# La lógica del lazo depende de esta forma, no de una base de datos concreta.
# En diseño se usa la implementación en memoria; en producción, una que escribe a
# Postgres/Redis — sin cambiar la lógica. Es el mismo principio orquestador/adaptador
# que ya usamos: el núcleo es universal, el almacén es enchufable.

class AlmacenEstado(Protocol):
    def leer(self, loop_id: str) -> EstadoLazo | None: ...
    def escribir(self, estado: EstadoLazo) -> None: ...
    def listar_pendientes(self, ahora_iso: str) -> list[EstadoLazo]:
        """Lazos cuya proxima_ejecucion ya pasó y están 'activo' — listos para despertar.

        REQUISITO DE CONCURRENCIA para la implementación de backend: dos workers no deben
        correr el mismo lazo a la vez. La implementación sobre Postgres debe tomar un lock
        por loop_id al entregar cada lazo pendiente (p.ej. SELECT ... FOR UPDATE SKIP LOCKED),
        de modo que un lazo ya tomado por un worker no se entregue a otro en el mismo tick.
        En memoria (pruebas) no aplica, pero el contrato lo exige en producción.
        """
        ...
    def eliminar(self, loop_id: str) -> None: ...


class AlmacenMemoria:
    """Implementación en memoria para diseño y pruebas. El backend la reemplaza."""
    def __init__(self):
        self._datos: dict[str, dict[str, Any]] = {}

    def leer(self, loop_id: str) -> EstadoLazo | None:
        d = self._datos.get(loop_id)
        return EstadoLazo.from_dict(json.loads(json.dumps(d))) if d else None

    def escribir(self, estado: EstadoLazo) -> None:
        self._datos[estado.loop_id] = estado.to_dict()

    def listar_pendientes(self, ahora_iso: str) -> list[EstadoLazo]:
        from datetime import datetime
        def _parse(s):
            try:
                return datetime.fromisoformat(s) if s else None
            except (ValueError, TypeError):
                return None
        ahora = _parse(ahora_iso)
        pendientes = []
        for d in self._datos.values():
            if d.get("estado_operativo") == "activo" and d.get("proxima_ejecucion"):
                prox = _parse(d["proxima_ejecucion"])
                # Comparar datetimes parseados, no strings (robusto ante formatos heterogéneos).
                if prox is not None and ahora is not None and prox <= ahora:
                    pendientes.append(EstadoLazo.from_dict(json.loads(json.dumps(d))))
        return pendientes

    def eliminar(self, loop_id: str) -> None:
        self._datos.pop(loop_id, None)
