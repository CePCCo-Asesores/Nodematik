#!/usr/bin/env python3
"""
Adaptador de web HTML para forge-extract. Maneja metodo_acceso: 'web'.

Descarga una página pública y extrae texto. ANTES de descargar, consulta robots.txt
como señal técnica de permiso — coherente con forge-sources, que ya decidió que la
fuente es permitida, pero el adaptador hace una verificación final de cortesía: si
robots.txt prohíbe la ruta, NO la extrae aunque el plan la marcara disponible (la
señal técnica al momento de extraer manda sobre una decisión previa que pudo quedar
desactualizada). Es el principio de no eludir límites, aplicado en el último momento.

Defensivo: valida el esquema de la URL, limita el tamaño de descarga, lee el charset
del header, y trata robots.txt de forma conservadora (si no se pudo verificar de
verdad, opera en degradado en vez de asumir permiso).
"""

from __future__ import annotations
import sys
import os
import re
import urllib.request
import urllib.error
import urllib.robotparser
from urllib.parse import urlparse
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contrato import ResultadoExtraccion, Registro

USER_AGENT = "forge-extract/1.0"
TIMEOUT = 20
MAX_BYTES = 1_000_000   # tope de descarga: una página enorme no debe inflar memoria
MAX_CHARS = 5000        # tope del texto extraído por registro
ESQUEMAS_PERMITIDOS = {"http", "https"}


class AdaptadorWeb:
    metodo = "web"

    def extraer(self, fuente: dict[str, Any], credenciales: dict[str, Any] | None) -> ResultadoExtraccion:
        nombre = fuente.get("fuente", "?")
        url = (fuente.get("metadatos") or {}).get("url") or fuente.get("url")
        datos_cubiertos = fuente.get("datos_que_cubre", [])

        if not url:
            return self._error(nombre, "La fuente web no trae 'url' en sus metadatos.")

        # Punto 5: validar esquema. Solo http/https — nada de file://, ftp://, data:, etc.
        parsed = urlparse(url)
        if parsed.scheme not in ESQUEMAS_PERMITIDOS:
            return self._error(nombre, f"Esquema de URL no permitido: '{parsed.scheme}'. Solo http/https.")
        if not parsed.netloc:
            return self._error(nombre, "URL sin host válido.")

        # Verificación final de robots.txt como señal técnica (conservadora).
        permitido = self._robots_permite(parsed, url)
        if permitido is False:
            return self._error(
                nombre,
                "robots.txt prohíbe rastrear esta ruta; no se extrae. (El principio de no eludir "
                "límites manda, aunque el plan la hubiera marcado disponible.)",
            )

        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                # Punto 4: limitar tamaño de descarga.
                cuerpo = resp.read(MAX_BYTES)
                # Punto 6: leer charset del header si lo declara.
                charset = self._charset_de(resp.headers.get("Content-Type", ""))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            return self._error(nombre, f"No se pudo descargar la página: {e}")

        html = cuerpo.decode(charset, errors="replace")
        texto = self._extraer_texto(html)
        if not texto.strip():
            return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="parcial",
                                       nota="Página descargada pero sin texto extraíble (¿contenido cargado por JS?).")

        # Punto 2: robots conservador. Si no se pudo verificar de verdad (None), degradado.
        if permitido is True:
            estado, nota = "ok", None
        else:
            estado = "degradado"
            nota = ("robots.txt no se pudo verificar; se procedió con cautela. "
                    "Confirmar permiso antes de un uso sostenido.")

        return ResultadoExtraccion(
            fuente=nombre, metodo_acceso=self.metodo, estado=estado, nota=nota,
            registros=[Registro(contenido=texto[:MAX_CHARS], fuente=nombre, metodo_acceso=self.metodo,
                                datos_cubiertos=list(datos_cubiertos), metadatos={"url": url})],
        )

    @staticmethod
    def _robots_permite(parsed, url: str) -> bool | None:
        """
        True permite, False prohíbe, None si no se pudo determinar de verdad.
        Punto 2: en vez de confiar en robotparser (que asume permiso si falla la lectura),
        descargamos robots.txt nosotros. Si no se pudo leer, devolvemos None (no True),
        para que el llamador opere en modo degradado en vez de asumir permiso.
        """
        try:
            robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
            req = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                if resp.status >= 400:
                    return None  # sin robots.txt legible: no asumir permiso
                contenido = resp.read(MAX_BYTES).decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            # 404 sin robots.txt: convención web = todo permitido. Otros códigos: incierto.
            return True if e.code == 404 else None
        except (urllib.error.URLError, TimeoutError):
            return None  # no se pudo verificar: degradado, no permiso asumido

        # Parsear robots.txt con robotparser sobre el contenido que ya descargamos.
        rp = urllib.robotparser.RobotFileParser()
        rp.parse(contenido.splitlines())
        return rp.can_fetch(USER_AGENT, url)

    @staticmethod
    def _charset_de(content_type: str) -> str:
        """Extrae charset del Content-Type; default utf-8."""
        m = re.search(r"charset=([\w\-]+)", content_type, re.IGNORECASE)
        if m:
            cs = m.group(1).lower()
            # validar que Python lo conozca; si no, utf-8
            try:
                "".encode(cs)
                return cs
            except LookupError:
                return "utf-8"
        return "utf-8"

    @staticmethod
    def _extraer_texto(html: str) -> str:
        """
        Quita scripts/estilos y tags; devuelve texto plano. Sin dependencias.
        Suficiente para MVP; para producción conviene BeautifulSoup/readability,
        que manejan mejor HTML malformado y extracción de contenido principal.
        """
        html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r"<[^>]+>", " ", html)
        html = re.sub(r"&nbsp;", " ", html)
        html = re.sub(r"\s+", " ", html)
        return html.strip()

    def _error(self, nombre: str, msg: str) -> ResultadoExtraccion:
        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="error", error=msg)
