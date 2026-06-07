"""
Contrato de tipos para forge-extract.

Define las estructuras compartidas entre el orquestador y los adaptadores.
Todos los scripts de forge-extract importan desde aquí.

Invariante de formato del registro_id: "src-N:rM"
  N = índice base-1 de la fuente en el plan (1, 2, 3…)
  M = contador base-0 de registro dentro de esa fuente (0, 1, 2…)
  El orquestador sella el registro_id — los adaptadores NO lo asignan.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol, runtime_checkable


@dataclass
class Registro:
    """Un único registro de datos obtenido de una fuente."""

    contenido: str                   # texto extraído
    fuente: str                      # id de la fuente en el plan (estable, único)
    metodo_acceso: str               # api|feed|web|archivo_cliente|dataset_abierto
    datos_cubiertos: list[str]       # subset de datos_requeridos que este registro aporta
    metadatos: dict                  # url/path/timestamp/keys específicos del adaptador
    obtenido_en: str                 # ISO 8601 UTC

    # Sellado por el orquestador DESPUÉS de que el adaptador devuelve el registro
    registro_id: str = field(default="")

    def __post_init__(self) -> None:
        if not self.contenido:
            raise ValueError("Registro.contenido no puede estar vacío.")
        if not self.fuente:
            raise ValueError("Registro.fuente no puede estar vacío.")
        if not self.metodo_acceso:
            raise ValueError("Registro.metodo_acceso no puede estar vacío.")
        if not self.obtenido_en:
            raise ValueError("Registro.obtenido_en no puede estar vacío.")


@dataclass
class ResultadoExtraccion:
    """Output completo de una pasada de extracción."""

    registros: list[Registro]
    fuentes_usadas: list[str]        # ids de fuentes de las que se obtuvo al menos un registro
    fuentes_omitidas: list[str]      # ids de fuentes que se omitieron con su razón
    cobertura_pct: float             # calculada honestamente por el orquestador
    datos_cubiertos: list[str]       # intersection(datos_cubiertos de registros, datos_requeridos)
    datos_faltantes: list[str]       # datos_requeridos sin cobertura
    requiere_revision_humana: bool   # propagado desde el plan — no es decisión del extractor
    extraido_en: str                 # ISO 8601 UTC

    def __post_init__(self) -> None:
        if not (0.0 <= self.cobertura_pct <= 100.0):
            raise ValueError(f"cobertura_pct fuera de rango: {self.cobertura_pct}")


@runtime_checkable
class Adaptador(Protocol):
    """
    Interfaz que todo adaptador de extracción debe implementar.

    obtener(fuente, credenciales) → list[Registro]

    La fuente es el objeto del plan (con id, metodo_acceso, metadatos, etc.).
    Las credenciales son las del cliente (BYO) asociadas al fuente.id.
    El adaptador NO asigna registro_id — eso lo hace el orquestador.

    Si la fuente no tiene datos disponibles en este momento, devolver lista vacía.
    Si hay un error irrecuperable, lanzar excepción (el orquestador la captura y registra).
    """

    def obtener(self, fuente: dict, credenciales: dict) -> list[Registro]:
        ...


def ahora_iso() -> str:
    """Timestamp ISO 8601 UTC del momento actual."""
    return datetime.now(timezone.utc).isoformat()


def sellar_registro_id(registro: Registro, src_idx: int, r_idx: int) -> None:
    """
    Sella el registro_id en el registro IN-PLACE.
    Formato: "src-N:rM" — N base-1, M base-0.
    Solo llamar desde el orquestador.
    """
    registro.registro_id = f"src-{src_idx}:r{r_idx}"
