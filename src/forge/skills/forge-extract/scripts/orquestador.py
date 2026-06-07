"""
Orquestador de extracción para forge-extract.

Despacha por método de acceso sin conocer las fuentes.
Sella registro_id único por registro.
Calcula cobertura honestamente: solo cuenta datos de fuentes exitosas.

Punto de extensión: la función `correr_tuberia` debe ser reemplazada
por el backend TypeScript al traducir este script. En el backend,
el dispatcher real conecta cada metodo_acceso con su adaptador TS.
"""

from __future__ import annotations

from .contrato import (
    Adaptador,
    Registro,
    ResultadoExtraccion,
    ahora_iso,
    sellar_registro_id,
)

# El backend conecta aquí los adaptadores reales.
# En producción, esta función es reemplazada por el dispatcher TypeScript.
_ADAPTADORES: dict[str, Adaptador] = {}


def registrar_adaptador(metodo: str, adaptador: Adaptador) -> None:
    """El backend registra sus adaptadores aquí antes de correr la tubería."""
    _ADAPTADORES[metodo] = adaptador


def correr_tuberia(fuente: dict, credenciales: dict) -> list[Registro]:
    """
    Punto de extensión: ejecuta el adaptador correspondiente al metodo_acceso.

    En el código de referencia Python, despacha a los adaptadores registrados.
    En el backend TypeScript, este punto se reemplaza con el dispatcher nativo.

    Lanza excepción si no hay adaptador registrado para el método.
    """
    metodo = fuente.get("metodo_acceso", "")
    adaptador = _ADAPTADORES.get(metodo)
    if adaptador is None:
        raise NotImplementedError(
            f"No hay adaptador registrado para metodo_acceso='{metodo}'. "
            "El backend debe conectar la implementación antes de correr la tubería."
        )
    return adaptador.obtener(fuente, credenciales)


def orquestar(plan: dict, credenciales_byo: dict | None = None) -> ResultadoExtraccion:
    """
    Ejecuta la extracción completa sobre el plan de forge-sources.

    Reglas de omisión:
      - Estado 'descartada' o 'dudosa' → siempre omitida.
      - Estado 'condicional' sin credencial → omitida.
      - Excepción durante extracción → omitida, error registrado.

    Calcula cobertura solo sobre las fuentes que realmente extrajeron datos.
    """
    credenciales = credenciales_byo or {}
    fuentes_plan = plan.get("fuentes", [])
    datos_requeridos: list[str] = plan.get("datos_requeridos", [])
    datos_req_set = set(datos_requeridos)

    registros_totales: list[Registro] = []
    fuentes_usadas: list[str] = []
    fuentes_omitidas: list[str] = []
    datos_cubiertos_set: set[str] = set()

    registro_global_counter = 0

    for src_idx, fuente in enumerate(fuentes_plan, start=1):
        if not isinstance(fuente, dict):
            continue

        fuente_id = fuente.get("id", f"fuente-{src_idx}")
        estado = fuente.get("estado", "")

        # Omitir descartadas y dudosas
        if estado in ("descartada", "dudosa"):
            fuentes_omitidas.append(fuente_id)
            continue

        # Omitir condicional sin credencial
        if estado == "condicional":
            if fuente_id not in credenciales:
                fuentes_omitidas.append(fuente_id)
                continue

        # Intentar extracción
        try:
            registros_fuente = correr_tuberia(fuente, credenciales)
        except Exception as exc:
            fuentes_omitidas.append(fuente_id)
            continue  # error registrado implícitamente por omitir la fuente

        if not registros_fuente:
            # Sin registros no es un error del orquestador — el adaptador decidió
            # que no había datos. Se registra como usada si no lanzó excepción.
            fuentes_usadas.append(fuente_id)
            continue

        # Sellar registro_id y acumular
        for r_idx, registro in enumerate(registros_fuente):
            sellar_registro_id(registro, src_idx, registro_global_counter)
            registro_global_counter += 1
            registros_totales.append(registro)

            for dato in registro.datos_cubiertos:
                if dato in datos_req_set:
                    datos_cubiertos_set.add(dato)

        fuentes_usadas.append(fuente_id)

    datos_cubiertos = sorted(datos_cubiertos_set)
    datos_faltantes = sorted(datos_req_set - datos_cubiertos_set)

    cobertura_pct = (
        len(datos_cubiertos_set) / len(datos_req_set) * 100
        if datos_req_set
        else 0.0
    )

    requiere_revision = bool(plan.get("requiere_revision_humana", False))

    return ResultadoExtraccion(
        registros=registros_totales,
        fuentes_usadas=fuentes_usadas,
        fuentes_omitidas=fuentes_omitidas,
        cobertura_pct=round(cobertura_pct, 2),
        datos_cubiertos=datos_cubiertos,
        datos_faltantes=datos_faltantes,
        requiere_revision_humana=requiere_revision,
        extraido_en=ahora_iso(),
    )
