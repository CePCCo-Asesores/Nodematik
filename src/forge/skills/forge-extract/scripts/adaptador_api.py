"""
Adaptador de extracción para APIs REST/JSON (metodo_acceso='api').

Llama el endpoint declarado en fuente.metadatos, parsea la respuesta JSON
y convierte cada elemento en un Registro.
Soporta autenticación por header (Bearer, API key) declarada en credenciales.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.parse
from typing import Any

from .contrato import Registro, ahora_iso


def obtener(fuente: dict, credenciales: dict) -> list[Registro]:
    """
    Llama el endpoint REST declarado en fuente.metadatos.
    Usa credenciales[fuente_id] si existen.
    Devuelve lista de Registros.
    Lanza excepción si el endpoint no responde o devuelve error HTTP.
    """
    fuente_id = fuente.get("id", "api")
    metadatos = fuente.get("metadatos") or {}
    endpoint = metadatos.get("endpoint") or metadatos.get("url", "")

    if not endpoint:
        raise ValueError(f"fuente '{fuente_id}' tipo 'api' requiere metadatos.endpoint.")

    creds_fuente = credenciales.get(fuente_id, {})
    headers = _construir_headers(creds_fuente)

    params = metadatos.get("params", {})
    if params:
        query = urllib.parse.urlencode(params)
        endpoint = f"{endpoint}?{query}" if "?" not in endpoint else f"{endpoint}&{query}"

    datos_json = _fetch_json(endpoint, headers)
    registros = _json_a_registros(datos_json, fuente, fuente_id)
    return registros


def _construir_headers(creds: dict) -> dict:
    headers: dict[str, str] = {
        "Accept": "application/json",
        "User-Agent": "ForgeExtract/1.0 (+https://nodematik.app)",
    }
    if not creds:
        return headers

    # Bearer token
    token = creds.get("bearer_token") or creds.get("access_token")
    if token:
        headers["Authorization"] = f"Bearer {token}"
        return headers

    # API key en header
    api_key = creds.get("api_key")
    key_header = creds.get("api_key_header", "X-API-Key")
    if api_key:
        headers[key_header] = api_key

    return headers


def _fetch_json(url: str, headers: dict) -> Any:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=20) as resp:
        contenido = resp.read()
        return json.loads(contenido)


def _json_a_registros(datos: Any, fuente: dict, fuente_id: str) -> list[Registro]:
    """
    Convierte la respuesta JSON en Registros.

    Estrategia de normalización:
    - Si la respuesta es una lista → cada elemento es un Registro.
    - Si es un dict con una clave que contiene lista → usar esa lista.
    - Si es un dict simple → un solo Registro.
    - Si es un string → un solo Registro con ese contenido.
    """
    datos_cubiertos = fuente.get("datos_que_cubre", [])
    metadatos_base = fuente.get("metadatos") or {}
    ts = ahora_iso()

    def hacer_registro(item: Any) -> Registro:
        if isinstance(item, str):
            contenido = item
        elif isinstance(item, dict):
            contenido = json.dumps(item, ensure_ascii=False)
        else:
            contenido = str(item)

        return Registro(
            contenido=contenido,
            fuente=fuente_id,
            metodo_acceso="api",
            datos_cubiertos=list(datos_cubiertos),
            metadatos={
                "endpoint": metadatos_base.get("endpoint", ""),
                "obtenido_en_raw": ts,
            },
            obtenido_en=ts,
        )

    if isinstance(datos, list):
        return [hacer_registro(item) for item in datos if item is not None]

    if isinstance(datos, dict):
        # Buscar la primera clave cuyo valor sea una lista
        clave_lista = metadatos_base.get("response_list_key")
        if clave_lista and clave_lista in datos:
            items = datos[clave_lista]
            if isinstance(items, list):
                return [hacer_registro(item) for item in items if item is not None]
        # Si no hay clave lista, tratar el dict completo como un solo registro
        return [hacer_registro(datos)]

    if isinstance(datos, str) and datos.strip():
        return [hacer_registro(datos)]

    return []
