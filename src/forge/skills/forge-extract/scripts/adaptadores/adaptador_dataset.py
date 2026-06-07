#!/usr/bin/env python3
"""
Adaptador de datasets abiertos para forge-extract. Maneja metodo_acceso: 'dataset_abierto'.

Descarga un dataset público (CSV o JSON por URL) y lo normaliza. Los datasets abiertos
son fuentes 'disponible' — datos gubernamentales, científicos, portales de datos
abiertos. Sin dependencias externas.

Defensivo: limita el tamaño de descarga, detecta formato por URL y por Content-Type,
soporta delimitadores distintos, items_path para JSON anidado, y no infla metadatos.
"""

from __future__ import annotations
import sys
import os
import json
import csv
import io
import urllib.request
import urllib.error
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contrato import ResultadoExtraccion, Registro

USER_AGENT = "forge-extract/1.0"
TIMEOUT = 30
MAX_BYTES = 10_000_000   # 10 MB: dataset más grande no se procesa entero
MAX_FILAS = 1000         # tope de filas/objetos
MAX_CHARS = 2000         # tope de contenido por registro
MAX_RAW_CHARS = 1000     # tope del raw en metadatos


class AdaptadorDataset:
    metodo = "dataset_abierto"

    def extraer(self, fuente: dict[str, Any], credenciales: dict[str, Any] | None) -> ResultadoExtraccion:
        nombre = fuente.get("fuente", "?")
        meta = fuente.get("metadatos") or {}
        url = meta.get("url") or fuente.get("url")
        formato = (meta.get("formato") or "").lower()
        datos_cubiertos = fuente.get("datos_que_cubre", [])

        if not url:
            return self._error(nombre, "La fuente dataset_abierto no trae 'url' en sus metadatos.")

        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                content_type = resp.headers.get("Content-Type", "")
                # Punto 1: límite de descarga. Leer un byte de más para detectar exceso.
                cuerpo = resp.read(MAX_BYTES + 1)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            return self._error(nombre, f"No se pudo descargar el dataset: {e}")

        if len(cuerpo) > MAX_BYTES:
            return ResultadoExtraccion(
                fuente=nombre, metodo_acceso=self.metodo, estado="degradado",
                nota=f"Dataset demasiado grande (> {MAX_BYTES} bytes); no se procesó para no romper memoria. "
                     f"Considera una fuente paginada o un subconjunto.",
            )

        raw = cuerpo.decode("utf-8", errors="replace")

        # Punto 2: detectar formato por URL Y por Content-Type.
        if not formato:
            formato = self._detectar_formato(url, content_type)

        try:
            if formato == "json":
                registros, truncado = self._json(raw, nombre, datos_cubiertos, meta)
            else:
                registros, truncado = self._csv(raw, nombre, datos_cubiertos, meta)
        except Exception as e:
            return self._error(nombre, f"Fallo al parsear el dataset ({formato}): {e}")

        # Punto 6: sin registros -> parcial con nota, no ok.
        if not registros:
            return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="parcial",
                                       nota="Dataset descargado pero sin filas/objetos extraíbles.")
        estado = "parcial" if truncado else "ok"
        nota = f"Dataset truncado a {MAX_FILAS} filas (tenía más)." if truncado else None
        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado=estado,
                                   registros=registros, nota=nota)

    @staticmethod
    def _detectar_formato(url: str, content_type: str) -> str:
        ct = content_type.lower()
        if "json" in ct:
            return "json"
        if "csv" in ct or "text/plain" in ct:
            return "csv"
        # fallback a la extensión de la URL
        return "json" if url.lower().rstrip("/").endswith(".json") else "csv"

    def _json(self, raw, nombre, dc, meta):
        data = json.loads(raw)
        # Punto 4: soportar items_path tipo {"data": [...]}.
        items_path = meta.get("items_path")
        if items_path:
            navegado = self._navegar(data, items_path)
            items = navegado if isinstance(navegado, list) else [navegado] if navegado is not None else []
        elif isinstance(data, list):
            items = data
        else:
            items = [data]

        registros, truncado = [], False
        for it in items:
            if len(registros) >= MAX_FILAS:
                truncado = True
                break
            registros.append(Registro(contenido=json.dumps(it, ensure_ascii=False)[:MAX_CHARS],
                                      fuente=nombre, metodo_acceso=self.metodo,
                                      datos_cubiertos=list(dc), metadatos=self._meta(it)))
        return registros, truncado

    def _csv(self, raw, nombre, dc, meta):
        # Punto 3: delimitador configurable (muchos datasets usan ';').
        sep = meta.get("delimiter", ",")
        registros, truncado = [], False
        for i, fila in enumerate(csv.DictReader(io.StringIO(raw), delimiter=sep)):
            if i >= MAX_FILAS:
                truncado = True
                break
            contenido = " | ".join(f"{k}={v}" for k, v in fila.items() if k is not None)
            registros.append(Registro(contenido=contenido[:MAX_CHARS], fuente=nombre,
                                      metodo_acceso=self.metodo, datos_cubiertos=list(dc),
                                      metadatos=self._meta(dict(fila))))
        return registros, truncado

    @staticmethod
    def _navegar(obj, path):
        for parte in path.split("."):
            if isinstance(obj, dict) and parte in obj:
                obj = obj[parte]
            else:
                return None
        return obj

    @staticmethod
    def _meta(it):
        """Punto 5: no inflar metadatos con raw enorme."""
        raw = json.dumps(it, ensure_ascii=False)
        if len(raw) <= MAX_RAW_CHARS:
            return dict(it) if isinstance(it, dict) else {"raw": it}
        return {"raw_truncado": raw[:MAX_RAW_CHARS], "nota": "raw truncado por tamaño"}

    def _error(self, nombre, msg):
        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="error", error=msg)
