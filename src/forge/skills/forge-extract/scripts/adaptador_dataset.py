"""
Adaptador de extracción para datasets abiertos (metodo_acceso='dataset_abierto').

Descarga datasets públicos desde URL (CSV o JSON).
No requiere credenciales — los datasets abiertos son accesibles públicamente.
La URL debe declararse en fuente.metadatos.url.

Diferencia con adaptador_web: este descarga un archivo de datos estructurado,
no una página HTML. El resultado son registros tabulares, no texto libre.
"""

from __future__ import annotations

import csv
import io
import json
import urllib.request
from typing import Any

from .contrato import Registro, ahora_iso

_USER_AGENT = "ForgeExtract/1.0 (+https://nodematik.app)"
_MAX_BYTES = 10 * 1024 * 1024  # 10 MB — límite razonable para datasets en memoria


def obtener(fuente: dict, credenciales: dict) -> list[Registro]:
    """
    Descarga el dataset desde la URL declarada en fuente.metadatos.url.
    Detecta formato por Content-Type o extensión de URL.
    Devuelve lista de Registros.
    """
    fuente_id = fuente.get("id", "dataset")
    metadatos = fuente.get("metadatos") or {}
    url = metadatos.get("url", "")

    if not url:
        raise ValueError(f"fuente '{fuente_id}' tipo 'dataset_abierto' requiere metadatos.url.")

    contenido_bytes, content_type = _descargar(url)
    datos_cubiertos = fuente.get("datos_que_cubre", [])
    ts = ahora_iso()

    formato = _detectar_formato(url, content_type)

    if formato == "csv":
        return _csv_a_registros(contenido_bytes, fuente_id, datos_cubiertos, url, ts)
    elif formato == "json":
        return _json_a_registros(contenido_bytes, fuente_id, datos_cubiertos, url, ts)
    else:
        # Formato desconocido — intentar JSON, luego CSV, luego texto
        try:
            return _json_a_registros(contenido_bytes, fuente_id, datos_cubiertos, url, ts)
        except (json.JSONDecodeError, UnicodeDecodeError):
            try:
                return _csv_a_registros(contenido_bytes, fuente_id, datos_cubiertos, url, ts)
            except Exception:
                texto = contenido_bytes.decode("utf-8", errors="replace")[:10_000]
                return [
                    Registro(
                        contenido=texto,
                        fuente=fuente_id,
                        metodo_acceso="dataset_abierto",
                        datos_cubiertos=list(datos_cubiertos),
                        metadatos={"url": url, "formato": "desconocido"},
                        obtenido_en=ts,
                    )
                ]


def _descargar(url: str) -> tuple[bytes, str]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json,text/csv,*/*"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        content_type = resp.headers.get("Content-Type", "")
        contenido = resp.read(_MAX_BYTES)
    return contenido, content_type


def _detectar_formato(url: str, content_type: str) -> str:
    ct_lower = content_type.lower()
    if "json" in ct_lower:
        return "json"
    if "csv" in ct_lower or "text/plain" in ct_lower:
        return "csv"

    url_lower = url.lower().split("?")[0]
    if url_lower.endswith(".json"):
        return "json"
    if url_lower.endswith(".csv") or url_lower.endswith(".tsv"):
        return "csv"

    return "desconocido"


def _csv_a_registros(
    contenido: bytes, fuente_id: str, datos_cubiertos: list, url: str, ts: str
) -> list[Registro]:
    texto = contenido.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(texto))
    registros = []
    for fila in reader:
        contenido_fila = json.dumps(dict(fila), ensure_ascii=False)
        registros.append(
            Registro(
                contenido=contenido_fila,
                fuente=fuente_id,
                metodo_acceso="dataset_abierto",
                datos_cubiertos=list(datos_cubiertos),
                metadatos={"url": url, "formato": "csv"},
                obtenido_en=ts,
            )
        )
    return registros


def _json_a_registros(
    contenido: bytes, fuente_id: str, datos_cubiertos: list, url: str, ts: str
) -> list[Registro]:
    datos = json.loads(contenido.decode("utf-8"))
    items: list[Any] = datos if isinstance(datos, list) else [datos]
    registros = []
    for item in items:
        texto = json.dumps(item, ensure_ascii=False) if not isinstance(item, str) else item
        registros.append(
            Registro(
                contenido=texto,
                fuente=fuente_id,
                metodo_acceso="dataset_abierto",
                datos_cubiertos=list(datos_cubiertos),
                metadatos={"url": url, "formato": "json"},
                obtenido_en=ts,
            )
        )
    return registros
