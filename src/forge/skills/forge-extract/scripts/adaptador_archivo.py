"""
Adaptador de extracción para archivos del cliente (metodo_acceso='archivo_cliente').

Lee archivos que el cliente provee directamente: CSV, TSV, JSON, texto plano.
SEGURIDAD: confinamiento de ruta vía FORGE_UPLOAD_ROOT para prevenir path traversal.

El path del archivo debe declararse en fuente.metadatos.ruta.
El archivo debe existir dentro de FORGE_UPLOAD_ROOT.
Si FORGE_UPLOAD_ROOT no está configurado, solo se permiten rutas relativas
al directorio de trabajo.
"""

from __future__ import annotations

import csv
import json
import os
import io
from pathlib import Path

from .contrato import Registro, ahora_iso

# Raíz de uploads configurada por el operador del sistema.
# Los paths de archivo nunca pueden escapar de este directorio.
_UPLOAD_ROOT = Path(os.environ.get("FORGE_UPLOAD_ROOT", "/tmp/forge-uploads")).resolve()


def obtener(fuente: dict, credenciales: dict) -> list[Registro]:
    """
    Lee el archivo declarado en fuente.metadatos.ruta.
    Detecta el formato por extensión (csv, tsv, json, txt) o por contenido.
    Devuelve lista de Registros.
    Lanza excepción si el archivo no existe o está fuera del upload root.
    """
    fuente_id = fuente.get("id", "archivo")
    metadatos = fuente.get("metadatos") or {}
    ruta_declarada = metadatos.get("ruta", "")

    if not ruta_declarada:
        raise ValueError(f"fuente '{fuente_id}' tipo 'archivo_cliente' requiere metadatos.ruta.")

    ruta_segura = _resolver_ruta_segura(ruta_declarada, fuente_id)
    datos_cubiertos = fuente.get("datos_que_cubre", [])
    ts = ahora_iso()

    extension = ruta_segura.suffix.lower()
    if extension == ".csv":
        registros = _leer_csv(ruta_segura, fuente_id, datos_cubiertos, ts, delimitador=",")
    elif extension == ".tsv":
        registros = _leer_csv(ruta_segura, fuente_id, datos_cubiertos, ts, delimitador="\t")
    elif extension == ".json":
        registros = _leer_json(ruta_segura, fuente_id, datos_cubiertos, ts)
    else:
        # Texto plano o extensión desconocida → leer como texto
        registros = _leer_texto(ruta_segura, fuente_id, datos_cubiertos, ts)

    return registros


def _resolver_ruta_segura(ruta_declarada: str, fuente_id: str) -> Path:
    """
    Resuelve la ruta y verifica que esté dentro de FORGE_UPLOAD_ROOT.
    Previene path traversal (../../../etc/passwd, rutas absolutas fuera del root).
    """
    ruta_candidate = (_UPLOAD_ROOT / ruta_declarada).resolve()

    # Verificar confinamiento
    try:
        ruta_candidate.relative_to(_UPLOAD_ROOT)
    except ValueError:
        raise ValueError(
            f"fuente '{fuente_id}': ruta '{ruta_declarada}' intenta salir del directorio "
            f"de uploads ({_UPLOAD_ROOT}). Operación rechazada por seguridad."
        )

    if not ruta_candidate.exists():
        raise FileNotFoundError(
            f"fuente '{fuente_id}': archivo no encontrado en '{ruta_candidate}'."
        )

    if not ruta_candidate.is_file():
        raise ValueError(
            f"fuente '{fuente_id}': la ruta '{ruta_candidate}' no es un archivo."
        )

    return ruta_candidate


def _leer_csv(
    ruta: Path, fuente_id: str, datos_cubiertos: list, ts: str, delimitador: str
) -> list[Registro]:
    registros = []
    with open(ruta, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=delimitador)
        for fila in reader:
            contenido = json.dumps(dict(fila), ensure_ascii=False)
            registros.append(
                Registro(
                    contenido=contenido,
                    fuente=fuente_id,
                    metodo_acceso="archivo_cliente",
                    datos_cubiertos=list(datos_cubiertos),
                    metadatos={"ruta": str(ruta), "tipo": "csv"},
                    obtenido_en=ts,
                )
            )
    return registros


def _leer_json(
    ruta: Path, fuente_id: str, datos_cubiertos: list, ts: str
) -> list[Registro]:
    with open(ruta, encoding="utf-8") as f:
        datos = json.load(f)

    items = datos if isinstance(datos, list) else [datos]
    registros = []
    for item in items:
        contenido = json.dumps(item, ensure_ascii=False) if not isinstance(item, str) else item
        registros.append(
            Registro(
                contenido=contenido,
                fuente=fuente_id,
                metodo_acceso="archivo_cliente",
                datos_cubiertos=list(datos_cubiertos),
                metadatos={"ruta": str(ruta), "tipo": "json"},
                obtenido_en=ts,
            )
        )
    return registros


def _leer_texto(
    ruta: Path, fuente_id: str, datos_cubiertos: list, ts: str
) -> list[Registro]:
    with open(ruta, encoding="utf-8") as f:
        contenido = f.read()

    if not contenido.strip():
        return []

    return [
        Registro(
            contenido=contenido[:50_000],  # límite razonable para texto plano
            fuente=fuente_id,
            metodo_acceso="archivo_cliente",
            datos_cubiertos=list(datos_cubiertos),
            metadatos={"ruta": str(ruta), "tipo": "texto"},
            obtenido_en=ts,
        )
    ]
