#!/usr/bin/env python3
"""
Orquestador universal de forge-extract.

No sabe extraer de ninguna fuente. Sabe despachar: para cada fuente del plan,
busca el adaptador registrado para su metodo_acceso y le pide el ResultadoExtraccion.
Recoge todo en el schema común. Agregar una fuente nueva al sistema = registrar un
adaptador nuevo aquí; el orquestador no cambia.

Mismo principio que el adaptador MCP del ENGINE: el núcleo es universal, la
especificidad vive en piezas intercambiables.

Uso:
    python orquestador.py plan.json [credenciales.json]
    (plan.json es la salida de forge-sources; credenciales.json mapea fuente -> creds BYO)

Salida: JSON con los resultados por fuente y un resumen de extracción.
"""

from __future__ import annotations
import json
import sys
from datetime import datetime, timezone
from typing import Any

from contrato import ResultadoExtraccion, Registro, ESTADOS_RESULTADO

# Los adaptadores se importan y registran. Cada uno declara qué metodo_acceso maneja.
# Para soportar una fuente nueva, se escribe un adaptador y se agrega a esta lista.
from adaptadores import adaptador_feed, adaptador_api, adaptador_web, adaptador_archivo, adaptador_dataset


def construir_registro_de_adaptadores() -> dict[str, Any]:
    """Mapa metodo_acceso -> adaptador. El orquestador solo conoce este mapa."""
    adaptadores = [
        adaptador_feed.AdaptadorFeed(),
        adaptador_api.AdaptadorAPI(),
        adaptador_web.AdaptadorWeb(),
        adaptador_archivo.AdaptadorArchivo(),
        adaptador_dataset.AdaptadorDataset(),
    ]
    registro = {}
    for a in adaptadores:
        registro[a.metodo] = a
    return registro


def extraer_plan(plan: dict[str, Any], credenciales: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Recorre las fuentes USABLES del plan (disponible y condicional con credencial),
    despacha cada una a su adaptador, y agrega los resultados al schema común.
    Las descartadas y dudosas se registran como 'omitida' — no se intentan.

    Produce tres bloques:
      - registros: lista plana de todos los registros (lo que el análisis consume)
      - resultados_por_fuente: traza ligera por fuente, SIN registros (para audit log)
      - resumen_extraccion: totales y cobertura demostrada
    """
    credenciales = credenciales or {}
    registro_adaptadores = construir_registro_de_adaptadores()
    requeridos = {d.strip() for d in plan.get("datos_requeridos", []) if isinstance(d, str) and d.strip()}

    registros_planos: list[dict[str, Any]] = []
    traza_por_fuente: list[dict[str, Any]] = []
    datos_cubiertos_global: set[str] = set()
    fuentes_intentadas = 0
    fuentes_ok = 0
    fuentes_degradadas = 0
    fuentes_error = 0
    fuentes_omitidas = 0
    contador_registros = 0  # para sellar registro_id únicos

    ahora = datetime.now(timezone.utc).isoformat()

    def clave_credencial(f: dict[str, Any]) -> Any:
        # id estable si la fuente lo trae (lo asigna forge-sources); si no, fallback al nombre.
        return credenciales.get(f.get("id")) if f.get("id") else credenciales.get(f.get("fuente"))

    for fuente in plan.get("fuentes", []):
        estado = fuente.get("estado")
        nombre = fuente.get("fuente", "?")
        metodo = fuente.get("metodo_acceso")

        # Descartada/dudosa: no son medios disponibles. Omitida, sin tocar.
        if estado not in {"disponible", "condicional"}:
            fuentes_omitidas += 1
            traza_por_fuente.append({
                "id": fuente.get("id"), "fuente": nombre, "metodo_acceso": metodo, "estado": "omitida",
                "omitida_por": "prohibida",
                "registros_obtenidos": 0, "datos_cubiertos": [],
                "error": None,
                "nota": f"Fuente en estado '{estado}': no se intenta (no es un medio disponible).",
            })
            continue

        # Condicional sin credencial: NO se intentó, así que es 'omitida' (no error).
        # omitida_por la marca como accionable: el cliente puede aportar la credencial.
        creds_fuente = clave_credencial(fuente)
        if estado == "condicional" and not creds_fuente:
            fuentes_omitidas += 1
            traza_por_fuente.append({
                "id": fuente.get("id"), "fuente": nombre, "metodo_acceso": metodo, "estado": "omitida",
                "omitida_por": "pendiente_credencial",
                "registros_obtenidos": 0, "datos_cubiertos": [],
                "error": None,
                "nota": "pendiente de credencial: el cliente debe aportar el acceso para intentar esta fuente.",
            })
            continue

        adaptador = registro_adaptadores.get(metodo)
        if adaptador is None:
            fuentes_error += 1
            traza_por_fuente.append({
                "id": fuente.get("id"), "fuente": nombre, "metodo_acceso": str(metodo), "estado": "error",
                "omitida_por": None,
                "registros_obtenidos": 0, "datos_cubiertos": [],
                "error": f"No hay adaptador registrado para metodo_acceso '{metodo}'. Registra uno o revisa el plan.",
                "nota": None,
            })
            continue

        fuentes_intentadas += 1
        try:
            resultado = adaptador.extraer(fuente, creds_fuente)
        except Exception as e:
            resultado = ResultadoExtraccion(
                fuente=nombre, metodo_acceso=str(metodo), estado="error",
                error=f"El adaptador lanzó una excepción: {e}",
            )

        # Acumular registros planos. La cobertura solo cuenta datos REQUERIDOS:
        # un adaptador puede traer datos extra, pero esos no inflan la cobertura.
        datos_de_esta_fuente: set[str] = set()
        for r in resultado.registros:
            if r.obtenido_en is None:
                r.obtenido_en = ahora
            # Sellar id único del registro si el adaptador no lo puso. Lo usa la evidencia
            # de forge-analyze para enlazar qué dato concreto justificó una capacidad.
            if r.registro_id is None:
                fid = fuente.get("id") or nombre
                r.registro_id = f"{fid}:r{contador_registros}"
                contador_registros += 1
            registros_planos.append(r.to_dict())
            for d in r.datos_cubiertos:
                if d in requeridos:
                    datos_cubiertos_global.add(d)
                    datos_de_esta_fuente.add(d)

        traza_por_fuente.append({
            "id": fuente.get("id"), "fuente": nombre, "metodo_acceso": resultado.metodo_acceso, "estado": resultado.estado,
            "omitida_por": None,
            "registros_obtenidos": len(resultado.registros),
            "datos_cubiertos": sorted(datos_de_esta_fuente),
            "error": resultado.error, "nota": resultado.nota,
        })

        # ok = éxito limpio; degradado = parcial con limitación; error = nada obtenido.
        if resultado.estado in {"ok", "parcial"}:
            fuentes_ok += 1
        elif resultado.estado == "degradado":
            fuentes_degradadas += 1
        else:
            fuentes_error += 1

    # Cobertura demostrada: qué datos_requeridos quedaron con registros reales.
    datos_sin_extraer = sorted(requeridos - datos_cubiertos_global)

    salida = {
        "registros": registros_planos,
        "resultados_por_fuente": traza_por_fuente,
        "resumen_extraccion": {
            "fuentes_intentadas": fuentes_intentadas,
            "fuentes_ok": fuentes_ok,
            "fuentes_degradadas": fuentes_degradadas,
            "fuentes_error": fuentes_error,
            "fuentes_omitidas": fuentes_omitidas,
            "total_registros": len(registros_planos),
            "datos_cubiertos": sorted(datos_cubiertos_global),
            "datos_sin_extraer": datos_sin_extraer,
            "extraccion_completa": len(datos_sin_extraer) == 0 and len(requeridos) > 0,
        },
    }
    return salida


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python orquestador.py plan.json [credenciales.json]"}, ensure_ascii=False))
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        plan = json.load(fh)

    credenciales = None
    if len(sys.argv) > 2:
        with open(sys.argv[2], "r", encoding="utf-8") as fh:
            credenciales = json.load(fh)

    salida = extraer_plan(plan, credenciales)
    print(json.dumps(salida, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
