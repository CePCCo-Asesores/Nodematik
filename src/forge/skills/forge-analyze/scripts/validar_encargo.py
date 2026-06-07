"""
Validador determinista para el ENCARGO DE FABRICACIÓN producido por forge-analyze.

Principio: verifica por recálculo — no confía en lo declarado.

Validaciones principales:
  1. Todos los registro_ids en evidencia_usada existen en el ResultadoExtraccion.
  2. reaprobacion_requerida es true para verbos 'modificar' y 'fabricar'.
  3. nivel_generalizacion 'universal' implica requiere_revision_humana.
  4. especificacion_factory tiene las 5 variables requeridas.
  5. Coherencia del encargo (no declarar datos_completos si hay faltantes).

Contrato:
  validar_encargo(encargo: dict, resultado_extraccion: dict) -> dict
    {
      valida: bool,
      errores: list[str],
      advertencias: list[str],
      requiere_revision_humana: bool
    }
"""

from __future__ import annotations

VERBOS_VALIDOS = frozenset({"reusar", "modificar", "fabricar"})
NIVELES_GENERALIZACION_VALIDOS = frozenset({"cliente", "vertical", "universal"})
VARIABLES_FACTORY_REQUERIDAS = frozenset({
    "verbo_central", "señal_disparo", "formato_salida", "complejidad", "distincion"
})
NIVELES_RIESGO_VALIDOS = frozenset({"bajo", "medio", "alto", "critico"})


def validar_encargo(encargo: dict, resultado_extraccion: dict) -> dict:
    if not isinstance(encargo, dict):
        return {
            "valida": False,
            "errores": ["El ENCARGO debe ser un objeto JSON."],
            "advertencias": [],
            "requiere_revision_humana": True,
        }

    errores: list[str] = []
    advertencias: list[str] = []

    # Extraer registro_ids disponibles del ResultadoExtraccion
    registro_ids_disponibles = _extraer_registro_ids(resultado_extraccion)

    _validar_decision(encargo, errores)
    _validar_especificacion_factory(encargo, errores, advertencias)
    _validar_evidencia_usada(encargo, errores, advertencias, registro_ids_disponibles)
    _validar_nivel_generalizacion(encargo, errores, advertencias)
    _validar_reaprobacion(encargo, errores)
    _validar_coherencia_datos(encargo, errores, advertencias)
    _validar_riesgo_acumulado(encargo, errores, advertencias)
    _validar_skill_objetivo(encargo, errores)

    requiere_revision = _evaluar_revision_humana(encargo, errores)

    return {
        "valida": len(errores) == 0,
        "errores": errores,
        "advertencias": advertencias,
        "requiere_revision_humana": requiere_revision,
    }


def _extraer_registro_ids(resultado_extraccion: dict) -> set[str]:
    """Extrae todos los registro_ids reales del ResultadoExtraccion."""
    if not isinstance(resultado_extraccion, dict):
        return set()
    registros = resultado_extraccion.get("registros", [])
    if not isinstance(registros, list):
        return set()
    ids = set()
    for r in registros:
        if isinstance(r, dict) and r.get("registro_id"):
            ids.add(str(r["registro_id"]))
    return ids


def _validar_decision(encargo: dict, errores: list) -> None:
    decision = encargo.get("decision")
    if decision not in VERBOS_VALIDOS:
        errores.append(
            f"'decision' inválida: '{decision}'. Verbos válidos: {sorted(VERBOS_VALIDOS)}."
        )


def _validar_especificacion_factory(
    encargo: dict, errores: list, advertencias: list
) -> None:
    ef = encargo.get("especificacion_factory")
    if ef is None:
        errores.append("'especificacion_factory' es requerida.")
        return
    if not isinstance(ef, dict):
        errores.append("'especificacion_factory' debe ser un objeto.")
        return

    faltantes = VARIABLES_FACTORY_REQUERIDAS - set(ef.keys())
    if faltantes:
        errores.append(
            f"'especificacion_factory' le faltan variables requeridas: {sorted(faltantes)}."
        )

    # Verificar que no estén vacías
    for var in VARIABLES_FACTORY_REQUERIDAS:
        valor = ef.get(var)
        if valor is not None and isinstance(valor, str) and not valor.strip():
            advertencias.append(
                f"'especificacion_factory.{var}' existe pero está vacía."
            )


def _validar_evidencia_usada(
    encargo: dict, errores: list, advertencias: list, registro_ids_disponibles: set
) -> None:
    evidencia = encargo.get("evidencia_usada")
    if evidencia is None:
        errores.append("'evidencia_usada' es requerida — la trazabilidad causal es una invariante.")
        return
    if not isinstance(evidencia, list):
        errores.append("'evidencia_usada' debe ser una lista.")
        return
    if len(evidencia) == 0:
        # Solo un error si el ResultadoExtraccion tenía registros
        if registro_ids_disponibles:
            errores.append(
                "'evidencia_usada' está vacía pero hay registros disponibles. "
                "Cada decisión del encargo debe tener evidencia que la sostenga."
            )

    ids_citados_no_encontrados: list[str] = []
    for i, entry in enumerate(evidencia):
        if not isinstance(entry, dict):
            errores.append(f"'evidencia_usada[{i}]' debe ser un objeto.")
            continue

        rid = entry.get("registro_id")
        if not rid or not isinstance(rid, str) or not rid.strip():
            errores.append(
                f"'evidencia_usada[{i}]' falta 'registro_id' (debe referenciar un registro real)."
            )
            continue

        # Verificar que el registro_id exista realmente
        if registro_ids_disponibles and rid not in registro_ids_disponibles:
            ids_citados_no_encontrados.append(rid)

        razon = entry.get("razon")
        if not razon or not isinstance(razon, str) or not razon.strip():
            errores.append(
                f"'evidencia_usada[{i}]' (registro_id='{rid}') falta 'razon' — "
                "explicar por qué ese registro motivó esta decisión."
            )

    if ids_citados_no_encontrados:
        errores.append(
            f"evidencia_usada cita registro_ids que no existen en el ResultadoExtraccion: "
            f"{ids_citados_no_encontrados}. Revisar la cadena de trazabilidad."
        )


def _validar_nivel_generalizacion(
    encargo: dict, errores: list, advertencias: list
) -> None:
    nivel = encargo.get("nivel_generalizacion")
    if nivel not in NIVELES_GENERALIZACION_VALIDOS:
        errores.append(
            f"'nivel_generalizacion' inválido: '{nivel}'. "
            f"Válidos: {sorted(NIVELES_GENERALIZACION_VALIDOS)}."
        )
        return

    if nivel == "universal" and not encargo.get("requiere_revision_humana"):
        errores.append(
            "'nivel_generalizacion: universal' requiere 'requiere_revision_humana: true' — "
            "un skill universal afecta a todas las organizaciones."
        )


def _validar_reaprobacion(encargo: dict, errores: list) -> None:
    decision = encargo.get("decision")
    reaprobacion = encargo.get("reaprobacion_requerida")

    if decision in ("modificar", "fabricar"):
        if reaprobacion is not True:
            errores.append(
                f"'reaprobacion_requerida' debe ser true cuando decision='{decision}'. "
                "Modificar o fabricar un skill siempre requiere nueva aprobación."
            )

    if decision == "reusar" and reaprobacion is True:
        # Advertencia, no error — puede ser intencional
        pass  # El validador no objeta si el LLM quiso ser más conservador


def _validar_coherencia_datos(
    encargo: dict, errores: list, advertencias: list
) -> None:
    completo = encargo.get("basado_en_datos_completos")
    faltantes = encargo.get("datos_faltantes", [])

    if completo is None:
        errores.append("'basado_en_datos_completos' (bool) es requerido.")
        return

    if not isinstance(completo, bool):
        errores.append("'basado_en_datos_completos' debe ser booleano.")
        return

    if not isinstance(faltantes, list):
        errores.append("'datos_faltantes' debe ser una lista.")
        return

    if completo is True and len(faltantes) > 0:
        errores.append(
            "'basado_en_datos_completos' es true pero 'datos_faltantes' no está vacío. "
            "Coherencia interna inválida."
        )

    if completo is False and len(faltantes) == 0:
        advertencias.append(
            "'basado_en_datos_completos' es false pero 'datos_faltantes' está vacío — "
            "declarar qué datos concretos faltan."
        )


def _validar_riesgo_acumulado(
    encargo: dict, errores: list, advertencias: list
) -> None:
    ra = encargo.get("riesgo_acumulado")
    if ra is None:
        errores.append("'riesgo_acumulado' es requerido.")
        return
    if not isinstance(ra, dict):
        errores.append("'riesgo_acumulado' debe ser un objeto con campo 'nivel'.")
        return

    nivel = ra.get("nivel")
    if nivel not in NIVELES_RIESGO_VALIDOS:
        errores.append(
            f"'riesgo_acumulado.nivel' inválido: '{nivel}'. "
            f"Válidos: {sorted(NIVELES_RIESGO_VALIDOS)}."
        )


def _validar_skill_objetivo(encargo: dict, errores: list) -> None:
    so = encargo.get("skill_objetivo")
    if so is None:
        errores.append("'skill_objetivo' (nombre del skill a construir o reusar) es requerido.")
        return
    if not isinstance(so, str) or not so.strip():
        errores.append("'skill_objetivo' debe ser una cadena no vacía en kebab-case.")


def _evaluar_revision_humana(encargo: dict, errores: list) -> bool:
    if errores:
        return True

    if encargo.get("requiere_revision_humana") is True:
        return True

    decision = encargo.get("decision")
    if decision in ("modificar", "fabricar"):
        return True

    nivel_gen = encargo.get("nivel_generalizacion")
    if nivel_gen == "universal":
        return True

    ra = encargo.get("riesgo_acumulado") or {}
    if ra.get("nivel") in ("alto", "critico"):
        return True

    return False
