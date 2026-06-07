"""
Adaptador de extracción para fuentes RSS/Atom (metodo_acceso='feed').

Lee el feed público, parsea las entradas y convierte cada una en un Registro.
No requiere credenciales — los feeds son públicos por definición.
Si la fuente requiere autenticación, usar adaptador_api en su lugar.
"""

from __future__ import annotations

import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from .contrato import Registro, ahora_iso

# Namespaces Atom
_NS_ATOM = "http://www.w3.org/2005/Atom"
_NS_DC = "http://purl.org/dc/elements/1.1/"


def obtener(fuente: dict, credenciales: dict) -> list[Registro]:
    """
    Lee el feed RSS/Atom de la URL declarada en fuente.metadatos.url.
    Devuelve lista de Registros, uno por entrada del feed.
    Lista vacía si no hay entradas nuevas o el feed está vacío.
    Lanza excepción si el URL no es accesible.
    """
    url = _extraer_url(fuente)
    contenido_raw = _fetch_url(url)
    entradas = _parsear_feed(contenido_raw, url)

    fuente_id = fuente.get("id", "feed")
    datos_cubiertos = fuente.get("datos_que_cubre", [])
    ts = ahora_iso()

    registros = []
    for entrada in entradas:
        registros.append(
            Registro(
                contenido=entrada["contenido"],
                fuente=fuente_id,
                metodo_acceso="feed",
                datos_cubiertos=list(datos_cubiertos),
                metadatos={
                    "url": url,
                    "titulo": entrada.get("titulo", ""),
                    "link": entrada.get("link", ""),
                    "publicado": entrada.get("publicado", ""),
                },
                obtenido_en=ts,
            )
        )
    return registros


def _extraer_url(fuente: dict) -> str:
    metadatos = fuente.get("metadatos") or {}
    url = metadatos.get("url") or fuente.get("url", "")
    if not url:
        raise ValueError(
            f"fuente '{fuente.get('id')}' tipo 'feed' requiere metadatos.url."
        )
    return str(url).strip()


def _fetch_url(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "ForgeExtract/1.0 (+https://nodematik.app)"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def _parsear_feed(contenido: bytes, url_origen: str) -> list[dict]:
    """Parsea RSS 2.0 y Atom 1.0. Devuelve lista de dicts con título, link, contenido, publicado."""
    try:
        root = ET.fromstring(contenido)
    except ET.ParseError as exc:
        raise ValueError(f"XML inválido en feed {url_origen}: {exc}") from exc

    entradas = []

    # RSS 2.0
    for item in root.findall(".//item"):
        entrada = _parsear_item_rss(item)
        if entrada:
            entradas.append(entrada)

    # Atom 1.0
    for entry in root.findall(f".//{{{_NS_ATOM}}}entry"):
        entrada = _parsear_entry_atom(entry)
        if entrada:
            entradas.append(entrada)

    return entradas


def _parsear_item_rss(item: ET.Element) -> dict | None:
    titulo = item.findtext("title", "").strip()
    link = item.findtext("link", "").strip()
    descripcion = item.findtext("description", "").strip()
    publicado = item.findtext("pubDate", "").strip()
    contenido = f"{titulo}\n{descripcion}".strip() if titulo or descripcion else ""
    if not contenido:
        return None
    return {"titulo": titulo, "link": link, "contenido": contenido, "publicado": publicado}


def _parsear_entry_atom(entry: ET.Element) -> dict | None:
    titulo_el = entry.find(f"{{{_NS_ATOM}}}title")
    titulo = (titulo_el.text or "").strip() if titulo_el is not None else ""

    link_el = entry.find(f"{{{_NS_ATOM}}}link")
    link = (link_el.get("href") or "").strip() if link_el is not None else ""

    summary_el = entry.find(f"{{{_NS_ATOM}}}summary")
    content_el = entry.find(f"{{{_NS_ATOM}}}content")
    cuerpo = ""
    if content_el is not None and content_el.text:
        cuerpo = content_el.text.strip()
    elif summary_el is not None and summary_el.text:
        cuerpo = summary_el.text.strip()

    publicado_el = entry.find(f"{{{_NS_ATOM}}}published")
    publicado = (publicado_el.text or "").strip() if publicado_el is not None else ""

    contenido = f"{titulo}\n{cuerpo}".strip() if titulo or cuerpo else ""
    if not contenido:
        return None
    return {"titulo": titulo, "link": link, "contenido": contenido, "publicado": publicado}
