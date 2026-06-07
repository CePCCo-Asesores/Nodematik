#!/usr/bin/env python3
"""
Adaptador de feeds RSS/Atom para forge-extract.

Funcional con la librería estándar (sin dependencias externas): descarga el feed,
lo parsea, y normaliza cada entrada al schema común. Los feeds son fuentes
'disponible' por excelencia — públicas, pensadas para consumo automatizado.

Maneja metodo_acceso: 'feed'.
La fuente del plan debe traer en sus metadatos la url del feed.
"""

from __future__ import annotations
import sys
import os
import urllib.request
import urllib.error
from xml.etree import ElementTree as ET
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contrato import ResultadoExtraccion, Registro

USER_AGENT = "forge-extract/1.0 (+operador; respeta robots y ToS)"
TIMEOUT = 20
MAX_ENTRADAS = 100  # límite de cortesía: un feed enorme no debe inflar memoria/tokens


class AdaptadorFeed:
    metodo = "feed"

    def extraer(self, fuente: dict[str, Any], credenciales: dict[str, Any] | None) -> ResultadoExtraccion:
        nombre = fuente.get("fuente", "?")
        url = (fuente.get("metadatos") or {}).get("url") or fuente.get("url")
        datos_cubiertos = fuente.get("datos_que_cubre", [])

        # Un feed público no usa credenciales. Si llegan, es señal de configuración
        # incorrecta aguas arriba (¿debió ser condicional con otro método?). Se informa
        # sin fallar — el feed se procesa igual.
        nota_extra = None
        if credenciales:
            nota_extra = ("Llegaron credenciales para un feed público, que no las usa. "
                          "Revisa si la fuente estaba mal clasificada en el plan.")

        if not url:
            return ResultadoExtraccion(
                fuente=nombre, metodo_acceso=self.metodo, estado="error",
                error="La fuente feed no trae 'url' en sus metadatos; no se puede descargar.",
            )

        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            return ResultadoExtraccion(
                fuente=nombre, metodo_acceso=self.metodo, estado="error",
                error=f"No se pudo descargar el feed: {e}",
            )

        try:
            root = ET.fromstring(raw)
        except ET.ParseError as e:
            return ResultadoExtraccion(
                fuente=nombre, metodo_acceso=self.metodo, estado="error",
                error=f"El feed no es XML válido: {e}",
            )

        registros, vacias_omitidas, truncado = self._parsear(root, nombre, datos_cubiertos)

        if not registros:
            return ResultadoExtraccion(
                fuente=nombre, metodo_acceso=self.metodo, estado="parcial",
                nota=self._unir_notas(
                    "El feed se descargó pero no se encontraron entradas con contenido real "
                    "(sin título ni descripción reconocibles).", nota_extra),
            )

        # Estado parcial si se truncó por el límite o si se omitieron entradas vacías.
        if truncado:
            estado = "parcial"
            nota = self._unir_notas(f"Feed truncado a {MAX_ENTRADAS} entradas (tenía más).", nota_extra)
        elif vacias_omitidas > 0:
            estado = "ok"
            nota = self._unir_notas(f"Se omitieron {vacias_omitidas} entradas sin contenido real.", nota_extra)
        else:
            estado = "ok"
            nota = nota_extra

        return ResultadoExtraccion(
            fuente=nombre, metodo_acceso=self.metodo, estado=estado, registros=registros, nota=nota,
        )

    def _parsear(self, root, nombre: str, datos_cubiertos: list[str]):
        """
        Soporta RSS 2.0 (<item>) y Atom (<entry>, con o sin namespace).
        Devuelve (registros, vacias_omitidas, truncado).
        Una entrada sin título ni descripción se omite — no es un dato, es ruido.
        """
        registros: list[Registro] = []
        vacias_omitidas = 0
        truncado = False

        def agregar(titulo, cuerpo, link, fecha):
            nonlocal vacias_omitidas, truncado
            # Punto 1 del review: no fabricar contenido placeholder.
            if not (titulo or cuerpo):
                vacias_omitidas += 1
                return
            if len(registros) >= MAX_ENTRADAS:
                truncado = True
                return
            contenido = " — ".join(p for p in (titulo, cuerpo) if p)
            registros.append(Registro(
                contenido=contenido, fuente=nombre, metodo_acceso=self.metodo,
                datos_cubiertos=list(datos_cubiertos),
                metadatos={"titulo": titulo, "url": link, "fecha": fecha},
            ))

        # RSS 2.0: item
        for item in root.iter("item"):
            if len(registros) >= MAX_ENTRADAS:
                truncado = True
                break
            agregar(self._texto(item, "title"), self._texto(item, "description"),
                    self._texto(item, "link"), self._texto(item, "pubDate"))

        # Atom: entry, tolerante a namespace (con el estándar o sin ninguno)
        atom_ns = "{http://www.w3.org/2005/Atom}"
        for entry in self._iter_entries(root, atom_ns):
            if len(registros) >= MAX_ENTRADAS:
                truncado = True
                break
            titulo = self._texto_flex(entry, "title", atom_ns)
            cuerpo = self._texto_flex(entry, "summary", atom_ns) or self._texto_flex(entry, "content", atom_ns)
            fecha = self._texto_flex(entry, "updated", atom_ns) or self._texto_flex(entry, "published", atom_ns)
            link_el = entry.find(f"{atom_ns}link")
            if link_el is None:
                link_el = entry.find("link")
            link = link_el.get("href") if link_el is not None else None
            agregar(titulo, cuerpo, link, fecha)

        return registros, vacias_omitidas, truncado

    @staticmethod
    def _iter_entries(root, atom_ns):
        """Entradas Atom con namespace estándar y, como respaldo, sin namespace."""
        entries = list(root.iter(f"{atom_ns}entry"))
        if not entries:
            entries = list(root.iter("entry"))
        return entries

    @staticmethod
    def _texto(parent, tag: str):
        el = parent.find(tag)
        return el.text.strip() if el is not None and el.text else None

    @staticmethod
    def _texto_flex(parent, tag: str, ns: str):
        """Busca un tag con namespace y, si no, sin él."""
        el = parent.find(f"{ns}{tag}")
        if el is None:
            el = parent.find(tag)
        return el.text.strip() if el is not None and el.text else None

    @staticmethod
    def _unir_notas(*notas):
        partes = [n for n in notas if n]
        return " | ".join(partes) if partes else None
