#!/usr/bin/env python3
"""
Adaptador de APIs REST/JSON para forge-extract. Maneja metodo_acceso: 'api'.

Funcional para APIs REST que devuelven JSON. La fuente del plan trae el endpoint
en sus metadatos. Si la fuente es condicional, las credenciales BYO del cliente
(API key, token) se inyectan en el header o query según declare la fuente.

Es el adaptador más delicado porque las APIs varían muchísimo, así que es defensivo:
nunca elude autenticación, valida que la respuesta sea JSON antes de parsear, limita
la cantidad de items, y no fabrica contenido de items sin datos reales.
"""

from __future__ import annotations
import sys
import os
import json
import urllib.request
import urllib.error
from urllib.parse import urlencode
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contrato import ResultadoExtraccion, Registro

USER_AGENT = "forge-extract/1.0"
TIMEOUT = 30
MAX_ITEMS = 100          # límite de cortesía, consistente con feed y dataset
MAX_RAW_CHARS = 1000     # tope para el raw guardado por registro (evita inflar la salida)


class AdaptadorAPI:
    metodo = "api"

    def extraer(self, fuente: dict[str, Any], credenciales: dict[str, Any] | None) -> ResultadoExtraccion:
        nombre = fuente.get("fuente", "?")
        meta = fuente.get("metadatos") or {}
        endpoint = meta.get("endpoint") or fuente.get("endpoint")
        datos_cubiertos = fuente.get("datos_que_cubre", [])

        if not endpoint:
            return self._error(nombre, "La fuente api no trae 'endpoint' en sus metadatos.")

        # Punto 2: defensa en profundidad. Si la fuente declara que requiere auth y no
        # llegó credencial, fallar antes de intentar nada — no confiar en el orquestador.
        if meta.get("requiere_auth") and not credenciales:
            return self._error(nombre, "La fuente requiere credencial BYO y no se aportó; no se intenta.")

        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if credenciales:
            key = credenciales.get("api_key") or credenciales.get("token")
            auth = meta.get("auth") or {}
            if key and auth.get("tipo") == "header":
                fmt = auth.get("formato", "{key}")
                headers[auth.get("header", "Authorization")] = fmt.format(key=key)
            elif key and auth.get("tipo") == "query":
                # Punto 1: encode correcto del parámetro de credencial.
                sep = "&" if "?" in endpoint else "?"
                endpoint = f"{endpoint}{sep}{urlencode({auth.get('param', 'api_key'): key})}"

        try:
            req = urllib.request.Request(endpoint, headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                content_type = resp.headers.get("Content-Type", "")
                cuerpo = resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return self._error(nombre, f"La API rechazó la credencial ({e.code}). No se reintenta sin credencial válida.")
            return self._error(nombre, f"HTTP {e.code} del endpoint.")
        except (urllib.error.URLError, TimeoutError) as e:
            return self._error(nombre, f"Fallo al consultar la API: {e}")

        # Punto 6: validar que la respuesta parezca JSON antes de parsear.
        # Una API que devuelve HTML (página de error, login) se atrapa aquí en vez
        # de lanzar una excepción de parseo confusa.
        texto = cuerpo.decode("utf-8", errors="replace").strip()
        parece_json = ("json" in content_type.lower()) or texto[:1] in ("{", "[")
        if not parece_json:
            return self._error(
                nombre,
                f"La respuesta no parece JSON (Content-Type: '{content_type or 'desconocido'}'). "
                f"¿La API devolvió HTML o un error? Primeros chars: {texto[:60]!r}",
            )

        try:
            payload = json.loads(texto)
        except json.JSONDecodeError as e:
            return self._error(nombre, f"La respuesta dijo ser JSON pero no parseó: {e}")

        # Normalización
        items_path = meta.get("items_path")
        if items_path:
            items = self._navegar(payload, items_path)
        elif isinstance(payload, list):
            # El payload ya es la lista de items (caso común en APIs REST que devuelven
            # un array directo). No hace falta items_path.
            items = payload
        else:
            items = None

        registros: list[Registro] = []
        vacios_omitidos = 0
        truncado = False

        if isinstance(items, list):
            campos = self._campos_contenido(meta)
            campos_clave = meta.get("campos_clave")  # qué guardar en metadatos (en vez del raw entero)
            for it in items:
                if len(registros) >= MAX_ITEMS:
                    truncado = True
                    break
                contenido = self._construir_contenido(it, campos)
                # Punto 4: no fabricar contenido de un dict crudo inútil. Si no hubo
                # campos de contenido reales, se omite el item.
                if not contenido:
                    vacios_omitidos += 1
                    continue
                registros.append(Registro(
                    contenido=contenido, fuente=nombre, metodo_acceso=self.metodo,
                    datos_cubiertos=list(datos_cubiertos),
                    metadatos=self._metadatos(it, campos_clave),
                ))
        else:
            # Sin items_path: un registro con el payload truncado (Punto 5).
            registros.append(Registro(
                contenido=json.dumps(payload, ensure_ascii=False)[:MAX_RAW_CHARS],
                fuente=nombre, metodo_acceso=self.metodo, datos_cubiertos=list(datos_cubiertos),
                metadatos={"forma": "payload completo (sin items_path declarado)"},
            ))

        if not registros:
            nota = "La API respondió pero no se encontraron items con contenido real."
            if vacios_omitidos:
                nota += f" Se omitieron {vacios_omitidos} items sin campos de contenido."
            return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="parcial", nota=nota)

        estado = "parcial" if truncado else "ok"
        nota = None
        if truncado:
            nota = f"Resultados truncados a {MAX_ITEMS} items (la API devolvió más)."
        elif vacios_omitidos:
            nota = f"Se omitieron {vacios_omitidos} items sin campos de contenido reales."

        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado=estado,
                                   registros=registros, nota=nota)

    # ── helpers ──

    @staticmethod
    def _campos_contenido(meta: dict[str, Any]) -> list[str]:
        # Punto 4: permitir varios campos a concatenar. Compatibilidad con el viejo
        # 'campo_contenido' singular.
        campos = meta.get("campos_contenido")
        if isinstance(campos, list) and campos:
            return campos
        uno = meta.get("campo_contenido")
        return [uno] if uno else ["text", "title", "name", "description"]

    @staticmethod
    def _construir_contenido(it: Any, campos: list[str]) -> str | None:
        if not isinstance(it, dict):
            # un item escalar (string/número) es contenido en sí mismo
            s = str(it).strip()
            return s or None
        partes = []
        for c in campos:
            v = it.get(c)
            if v not in (None, "", []):
                partes.append(str(v).strip())
        return " — ".join(partes) if partes else None

    @staticmethod
    def _metadatos(it: Any, campos_clave) -> dict[str, Any]:
        # Punto 5: no volcar raw enorme. Si la fuente declara campos_clave, guardar solo
        # esos; si no, guardar el raw truncado a una representación corta.
        if not isinstance(it, dict):
            return {}
        if isinstance(campos_clave, list) and campos_clave:
            return {c: it.get(c) for c in campos_clave if c in it}
        raw = json.dumps(it, ensure_ascii=False)
        if len(raw) <= MAX_RAW_CHARS:
            return {"raw": it}
        return {"raw_truncado": raw[:MAX_RAW_CHARS], "nota": "raw truncado por tamaño"}

    @staticmethod
    def _navegar(obj: Any, path: str) -> Any:
        for parte in path.split("."):
            if isinstance(obj, dict) and parte in obj:
                obj = obj[parte]
            else:
                return None
        return obj

    def _error(self, nombre: str, msg: str) -> ResultadoExtraccion:
        return ResultadoExtraccion(fuente=nombre, metodo_acceso=self.metodo, estado="error", error=msg)
