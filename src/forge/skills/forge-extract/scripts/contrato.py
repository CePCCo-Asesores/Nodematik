#!/usr/bin/env python3
"""
Contrato universal del extractor forge-extract.

Define la frontera entre el orquestador y los adaptadores. El orquestador NO sabe
extraer de ninguna fuente; sabe que todo adaptador recibe una fuente del plan y
devuelve un ResultadoExtraccion en el schema común. Cualquier fuente nueva queda
soportada agregando un adaptador que cumpla este contrato — sin tocar el orquestador.

Este módulo no extrae nada: solo define las formas. Es el equivalente al schema
YAML universal del ENGINE, aplicado a la extracción.
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Protocol


# ─── El schema común de salida ────────────────────────────────────────────────
#
# Todo dato extraído, venga de una API, un feed, una web o un archivo, se normaliza
# a este registro. El resto del operador (análisis, entrega) consume SIEMPRE este
# formato, nunca el formato crudo de la fuente. Esa uniformidad es lo que permite
# que un mismo skill de análisis sirva para datos de cualquier origen.

@dataclass
class Registro:
    """Una unidad de dato normalizada, agnóstica de su fuente."""
    contenido: str                      # el texto/dato principal, normalizado
    fuente: str                         # nombre de la fuente de la que vino
    metodo_acceso: str                  # cómo se obtuvo (api, feed, web, ...)
    registro_id: str | None = None      # id único del registro (lo sella el orquestador);
                                        # forge-analyze lo usa para enlazar evidencia
    datos_cubiertos: list[str] = field(default_factory=list)  # qué datos_requeridos satisface
    metadatos: dict[str, Any] = field(default_factory=dict)   # fecha, autor, url, etc. (libre)
    obtenido_en: str | None = None      # timestamp ISO de la extracción

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ResultadoExtraccion:
    """Lo que un adaptador devuelve al orquestador para una fuente."""
    fuente: str
    metodo_acceso: str
    estado: str                         # 'ok' | 'parcial' | 'error' | 'degradado'
    registros: list[Registro] = field(default_factory=list)
    error: str | None = None            # mensaje si estado es 'error'
    nota: str | None = None             # explicación si 'parcial' o 'degradado'

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["registros"] = [r.to_dict() for r in self.registros]
        return d


ESTADOS_RESULTADO = {"ok", "parcial", "error", "degradado"}


# ─── La interfaz que todo adaptador cumple ────────────────────────────────────
#
# El orquestador depende de esta forma, no de implementaciones concretas. Un
# adaptador es cualquier cosa que sepa, dada una fuente del plan y las credenciales
# que el cliente aportó (si las hay), devolver un ResultadoExtraccion. Punto.

class Adaptador(Protocol):
    # cada adaptador declara qué metodo_acceso maneja
    metodo: str

    def extraer(self, fuente: dict[str, Any], credenciales: dict[str, Any] | None) -> ResultadoExtraccion:
        """
        fuente: una entrada del plan de forge-sources (estado, metodo_acceso,
                datos_que_cubre, metadatos de acceso como url/endpoint/path).
        credenciales: lo que el cliente aportó para fuentes condicionales (BYO),
                      o None si la fuente es disponible sin credencial.
        Devuelve un ResultadoExtraccion en el schema común.

        Un adaptador NUNCA intenta una fuente que no le corresponde, y NUNCA
        elude un límite: si la fuente requiere algo que no tiene, devuelve estado
        'error' con explicación, no fuerza el acceso.
        """
        ...
