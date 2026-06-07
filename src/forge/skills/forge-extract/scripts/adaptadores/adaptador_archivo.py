#!/usr/bin/env python3
"""
Adaptador de archivos del cliente para forge-extract. Maneja metodo_acceso: 'archivo_cliente'.

El cliente aporta el archivo (lo sube) y tiene derecho a usarlo — por eso es una
fuente que el BYO habilita. Soporta CSV, TSV, JSON y texto plano sin dependencias.
La fuente del plan trae la ruta del archivo en sus metadatos.

Defensivo: confina la lectura a un directorio permitido (no lee cualquier path del
sistema), limita tamaño/filas, no infla metadatos con raw enorme, y maneja CSV sin
headers y encodings no-UTF8.
"""

from __future__ import annotations
import sys
import os
import json
import csv
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contrato import ResultadoExtraccion, Registro

# Punto 1: confinar la lectura. El adaptador solo lee archivos que el cliente aportó
# por la vía legítima (la carpeta de uploads). Aceptar cualquier path absoluto dejaría
# que una ruta malformada en el plan leyera archivos del sistema (/etc/passwd, secretos).
# Se puede configurar por entorno, con default a la carpeta de uploads del operador.
UPLOAD_ROOT = os.environ.get("FORGE_UPLOAD_ROOT", "/mnt/user-data/uploads")

MAX_BYTES = 10_000_000   # 10 MB: archivo más grande no se procesa
MAX_REGISTROS = 1000     # tope de filas/objetos
MAX_CHARS = 5000         # tope de texto por registro
MAX_RAW_CHARS = 1000     # tope del raw guardado en metadatos


class AdaptadorArchivo:
    metodo = "archivo_cliente"

    def extraer(self, fuente: dict[str, Any], credenciales: dict[str, Any] | None) -> ResultadoExtraccion:
        nombre = fuente.get("fuente", "?")
        meta = fuente.get("metadatos") or {}
        ruta = meta.get("ruta") or fuente.get("ruta")
        datos_cubiertos = fuente.get("datos_que_cubre", [])

        if not ruta:
            return self._error(nombre, "La fuente archivo_cliente no trae 'ruta' en sus metadatos.")

        # Punto 1: validar que la ruta real esté dentro del directorio permitido.
        # realpath resuelve symlinks y '..' para que no se pueda escapar del confinamiento.
        try:
            ruta_real = os.path.realpath(ruta)
            root_real = os.path.realpath(UPLOAD_ROOT)
        except Exception as e:
            return self._error(nombre, f"Ruta inválida: {e}")
        if not (ruta_real == root_real or ruta_real.startswith(root_real + os.sep)):
            return self._error(
                nombre,
                f"La ruta está fuera del directorio permitido de uploads. Solo se leen archivos "
                f"que el cliente aportó por la vía legítima, no rutas arbitrarias del sistema.",
            )

        if not os.path.exists(ruta_real):
            return self._error(nombre, f"El archivo no existe en la ruta: {ruta}")
        if not os.path.isfile(ruta_real):
            return self._error(nombre, "La ruta no apunta a un archivo regular.")

        # Punto 2: límite de tamaño antes de leer.
        try:
            tam = os.path.getsize(ruta_real)
        except OSError as e:
            return self._error(nombre, f"No se pudo medir el archivo: {e}")
        if tam > MAX_BYTES:
            return self._error(nombre, f"El archivo excede el límite de {MAX_BYTES} bytes ({tam} bytes).")

        ext = os.path.splitext(ruta_real)[1].lower()
        try:
            if ext == ".json":
                registros, truncado = self._leer_json(ruta_real, nombre, datos_cubiertos)
            elif ext in (".csv", ".tsv"):
                registros, truncado = self._leer_csv(ruta_real, nombre, datos_cubiertos,
                                                     sep="\t" if ext == ".tsv" else ",")
            else:
                registros, truncado = self._leer_texto(ruta_real, nombre, datos_cubiertos)
        except Exception as e:
            return self._error(nombre, f"Fallo al leer el archivo: {e}")

        if not registros:
            return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="parcial",
                                       nota="Archivo leído pero sin contenido extraíble.")
        estado = "parcial" if truncado else "ok"
        nota = f"Archivo truncado a {MAX_REGISTROS} registros (tenía más)." if truncado else None
        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado=estado,
                                   registros=registros, nota=nota)

    def _abrir(self, ruta):
        """Punto 6: utf-8 con fallback a latin-1 para clientes reales con encodings legacy."""
        try:
            with open(ruta, "r", encoding="utf-8") as fh:
                return fh.read(), "utf-8"
        except UnicodeDecodeError:
            with open(ruta, "r", encoding="latin-1") as fh:
                return fh.read(), "latin-1"

    def _leer_json(self, ruta, nombre, dc):
        contenido, _ = self._abrir(ruta)
        data = json.loads(contenido)
        items = data if isinstance(data, list) else [data]
        registros = []
        truncado = False
        for it in items:
            if len(registros) >= MAX_REGISTROS:  # Punto 3: limitar JSON grande
                truncado = True
                break
            texto = json.dumps(it, ensure_ascii=False)[:MAX_CHARS]
            registros.append(Registro(contenido=texto, fuente=nombre, metodo_acceso=self.metodo,
                                      datos_cubiertos=list(dc), metadatos=self._meta(it)))
        return registros, truncado

    def _leer_csv(self, ruta, nombre, dc, sep):
        contenido, _ = self._abrir(ruta)
        import io
        # Punto 5: detectar si hay headers. Si la primera fila no parece encabezado
        # (p.ej. todo numérico), DictReader produciría claves raras; usamos columnas genéricas.
        sample = contenido[:4096]
        try:
            tiene_header = csv.Sniffer().has_header(sample)
        except csv.Error:
            tiene_header = True  # asumir header si no se puede decidir

        registros = []
        truncado = False
        if tiene_header:
            lector = csv.DictReader(io.StringIO(contenido), delimiter=sep)
            for fila in lector:
                if len(registros) >= MAX_REGISTROS:
                    truncado = True
                    break
                contenido_reg = " | ".join(f"{k}={v}" for k, v in fila.items() if k is not None)
                registros.append(Registro(contenido=contenido_reg[:MAX_CHARS], fuente=nombre,
                                          metodo_acceso=self.metodo, datos_cubiertos=list(dc),
                                          metadatos=self._meta(dict(fila))))
        else:
            lector = csv.reader(io.StringIO(contenido), delimiter=sep)
            for fila in lector:
                if len(registros) >= MAX_REGISTROS:
                    truncado = True
                    break
                d = {f"col{i+1}": v for i, v in enumerate(fila)}
                contenido_reg = " | ".join(f"{k}={v}" for k, v in d.items())
                registros.append(Registro(contenido=contenido_reg[:MAX_CHARS], fuente=nombre,
                                          metodo_acceso=self.metodo, datos_cubiertos=list(dc),
                                          metadatos=self._meta(d)))
        return registros, truncado

    def _leer_texto(self, ruta, nombre, dc):
        contenido, _ = self._abrir(ruta)
        if not contenido.strip():
            return [], False
        return [Registro(contenido=contenido[:MAX_CHARS], fuente=nombre, metodo_acceso=self.metodo,
                         datos_cubiertos=list(dc), metadatos={"ruta": os.path.basename(ruta)})], False

    @staticmethod
    def _meta(it):
        """Punto 4: no inflar metadatos con raw enorme."""
        raw = json.dumps(it, ensure_ascii=False)
        if len(raw) <= MAX_RAW_CHARS:
            return dict(it) if isinstance(it, dict) else {"raw": it}
        return {"raw_truncado": raw[:MAX_RAW_CHARS], "nota": "raw truncado por tamaño"}

    def _error(self, nombre, msg):
        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="error", error=msg)
