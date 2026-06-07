"""
Validador determinista para la FICHA producida por forge-intake.

Contrato:
  validar_ficha(ficha: dict) -> dict
    {
      valida: bool,
      errores: list[str],      # bloquean — la FICHA no puede usarse
      advertencias: list[str], # informativos — la FICHA puede usarse con precaución
      requiere_revision_humana: bool
    }

No lanza excepciones. Errores de parseo se reportan en errores[].
"""

from __future__ import annotations

TIPOS_ACCION_VALIDOS = frozenset({
    "diagnostico", "planificacion", "ejecucion", "monitoreo", "creacion_capacidad"
})

NIVELES_RIESGO_VALIDOS = frozenset({"bajo", "medio", "alto", "critico"})

TIPOS_TEMPORAL_VALIDOS = frozenset({"unico", "continuo"})

CAMPOS_REQUERIDOS = [
    "objetivo",
    "datos_requeridos",
    "fuentes_candidatas",
    "eje_temporal",
    "entregable",
    "pasos",
    "tipo_de_accion",
    "riesgo_operativo",
    "suficiencia",
    "faltantes",
    "skill_destino_sugerido",
]


def validar_ficha(ficha: dict) -> dict:
    if not isinstance(ficha, dict):
        return {
            "valida": False,
            "errores": ["La FICHA debe ser un objeto JSON, no un tipo primitivo."],
            "advertencias": [],
            "requiere_revision_humana": True,
        }

    errores: list[str] = []
    advertencias: list[str] = []

    # 1. Campos requeridos presentes
    for campo in CAMPOS_REQUERIDOS:
        if campo not in ficha:
            errores.append(f"Campo requerido ausente: '{campo}'.")

    # Continuar validando solo los campos que existen
    _validar_objetivo(ficha, errores, advertencias)
    _validar_datos_requeridos(ficha, errores, advertencias)
    _validar_fuentes_candidatas(ficha, errores, advertencias)
    _validar_eje_temporal(ficha, errores, advertencias)
    _validar_pasos(ficha, errores, advertencias)
    _validar_tipo_de_accion(ficha, errores, advertencias)
    _validar_riesgo_operativo(ficha, errores, advertencias)
    _validar_suficiencia_y_faltantes(ficha, errores, advertencias)
    _validar_skill_destino_sugerido(ficha, errores, advertencias)

    requiere_revision = _evaluar_revision_humana(ficha, errores)

    return {
        "valida": len(errores) == 0,
        "errores": errores,
        "advertencias": advertencias,
        "requiere_revision_humana": requiere_revision,
    }


def _validar_objetivo(ficha: dict, errores: list, advertencias: list) -> None:
    objetivo = ficha.get("objetivo")
    if objetivo is None:
        return
    if not isinstance(objetivo, str) or not objetivo.strip():
        errores.append("'objetivo' debe ser una cadena no vacía.")
    elif len(objetivo.strip()) < 10:
        advertencias.append("'objetivo' parece demasiado corto — verificar que describe el resultado esperado.")


def _validar_datos_requeridos(ficha: dict, errores: list, advertencias: list) -> None:
    dr = ficha.get("datos_requeridos")
    if dr is None:
        return
    if not isinstance(dr, list):
        errores.append("'datos_requeridos' debe ser una lista.")
        return
    if len(dr) == 0:
        errores.append("'datos_requeridos' no puede estar vacía — al menos un dato debe estar declarado.")
    for i, item in enumerate(dr):
        if not isinstance(item, str) or not item.strip():
            errores.append(f"'datos_requeridos[{i}]' debe ser una cadena no vacía.")


def _validar_fuentes_candidatas(ficha: dict, errores: list, advertencias: list) -> None:
    fc = ficha.get("fuentes_candidatas")
    if fc is None:
        return
    if not isinstance(fc, list):
        errores.append("'fuentes_candidatas' debe ser una lista.")
        return
    if len(fc) == 0:
        advertencias.append("'fuentes_candidatas' está vacía — forge-sources no tendrá candidatos para evaluar.")


def _validar_eje_temporal(ficha: dict, errores: list, advertencias: list) -> None:
    et = ficha.get("eje_temporal")
    if et is None:
        return
    if not isinstance(et, dict):
        errores.append("'eje_temporal' debe ser un objeto con al menos el campo 'tipo'.")
        return

    tipo = et.get("tipo")
    if tipo not in TIPOS_TEMPORAL_VALIDOS:
        errores.append(
            f"'eje_temporal.tipo' inválido: '{tipo}'. Valores válidos: {sorted(TIPOS_TEMPORAL_VALIDOS)}."
        )
        return

    if tipo == "continuo":
        ritmo = et.get("ritmo")
        if not ritmo or not isinstance(ritmo, str) or not ritmo.strip():
            errores.append(
                "'eje_temporal.ritmo' es requerido cuando tipo='continuo'. "
                "Ejemplos: 'diario', 'semanal', 'cada 6h'."
            )


def _validar_pasos(ficha: dict, errores: list, advertencias: list) -> None:
    pasos = ficha.get("pasos")
    if pasos is None:
        return
    if not isinstance(pasos, list):
        errores.append("'pasos' debe ser una lista.")
        return
    if len(pasos) == 0:
        advertencias.append("'pasos' está vacía — el pipeline no sabrá qué pasos ejecutar.")
    for i, paso in enumerate(pasos):
        if not isinstance(paso, dict):
            errores.append(f"'pasos[{i}]' debe ser un objeto con campos 'descripcion' y 'tipo'.")
            continue
        if "descripcion" not in paso:
            errores.append(f"'pasos[{i}]' falta el campo 'descripcion'.")
        tipo_paso = paso.get("tipo")
        if tipo_paso not in ("mecanico", "con-juicio"):
            errores.append(
                f"'pasos[{i}].tipo' inválido: '{tipo_paso}'. Valores válidos: 'mecanico', 'con-juicio'."
            )


def _validar_tipo_de_accion(ficha: dict, errores: list, advertencias: list) -> None:
    ta = ficha.get("tipo_de_accion")
    if ta is None:
        return
    if ta not in TIPOS_ACCION_VALIDOS:
        errores.append(
            f"'tipo_de_accion' inválido: '{ta}'. Valores válidos: {sorted(TIPOS_ACCION_VALIDOS)}."
        )


def _validar_riesgo_operativo(ficha: dict, errores: list, advertencias: list) -> None:
    ro = ficha.get("riesgo_operativo")
    if ro is None:
        return
    if not isinstance(ro, dict):
        errores.append("'riesgo_operativo' debe ser un objeto con campos 'nivel', 'requiere_aprobacion', 'razon'.")
        return

    nivel = ro.get("nivel")
    if nivel not in NIVELES_RIESGO_VALIDOS:
        errores.append(
            f"'riesgo_operativo.nivel' inválido: '{nivel}'. Valores válidos: {sorted(NIVELES_RIESGO_VALIDOS)}."
        )

    if "requiere_aprobacion" not in ro:
        errores.append("'riesgo_operativo.requiere_aprobacion' (bool) es requerido.")
    elif not isinstance(ro["requiere_aprobacion"], bool):
        errores.append("'riesgo_operativo.requiere_aprobacion' debe ser booleano.")

    razon = ro.get("razon")
    if not razon or not isinstance(razon, str) or not razon.strip():
        errores.append("'riesgo_operativo.razon' es requerida y debe ser una cadena no vacía.")

    # Coherencia: nivel alto/critico debería requerir aprobación
    if nivel in ("alto", "critico") and ro.get("requiere_aprobacion") is False:
        advertencias.append(
            f"Riesgo nivel '{nivel}' con requiere_aprobacion=false — verificar si esta combinación es intencional."
        )


def _validar_suficiencia_y_faltantes(ficha: dict, errores: list, advertencias: list) -> None:
    suficiencia = ficha.get("suficiencia")
    faltantes = ficha.get("faltantes")

    if suficiencia is None:
        return

    if not isinstance(suficiencia, bool):
        errores.append("'suficiencia' debe ser booleano (true o false).")
        return

    if faltantes is not None and not isinstance(faltantes, list):
        errores.append("'faltantes' debe ser una lista.")
        return

    if suficiencia is False:
        faltantes_val = faltantes or []
        if len(faltantes_val) == 0:
            errores.append(
                "'suficiencia' es false pero 'faltantes' está vacío. "
                "Declarar al menos una pregunta concreta sobre lo que falta."
            )

    if suficiencia is True and faltantes and len(faltantes) > 0:
        advertencias.append(
            "'suficiencia' es true pero 'faltantes' tiene elementos — verificar coherencia."
        )


def _validar_skill_destino_sugerido(ficha: dict, errores: list, advertencias: list) -> None:
    sd = ficha.get("skill_destino_sugerido")
    if sd is None:
        return
    if not isinstance(sd, dict):
        errores.append("'skill_destino_sugerido' debe ser un objeto con campos 'nombre', 'razon', 'fallback'.")
        return

    nombre = sd.get("nombre")
    if not nombre or not isinstance(nombre, str) or not nombre.strip():
        errores.append("'skill_destino_sugerido.nombre' es requerido.")

    razon = sd.get("razon")
    if not razon or not isinstance(razon, str) or not razon.strip():
        errores.append("'skill_destino_sugerido.razon' es requerida.")

    # fallback es opcional pero si existe debe ser string
    fallback = sd.get("fallback")
    if fallback is not None and (not isinstance(fallback, str) or not fallback.strip()):
        advertencias.append("'skill_destino_sugerido.fallback' existe pero no es una cadena válida.")


def _evaluar_revision_humana(ficha: dict, errores: list) -> bool:
    # Hay errores → siempre requiere revisión antes de proceder
    if errores:
        return True

    ro = ficha.get("riesgo_operativo") or {}
    nivel = ro.get("nivel", "")
    requiere_aprobacion = ro.get("requiere_aprobacion", False)

    if nivel in ("alto", "critico"):
        return True

    if requiere_aprobacion:
        return True

    tipo_accion = ficha.get("tipo_de_accion", "")
    if tipo_accion == "ejecucion":
        # Acciones de ejecución directa siempre necesitan revisión
        return True

    # Lazo continuo sobre datos sensibles — señal de cautela
    et = ficha.get("eje_temporal") or {}
    if et.get("tipo") == "continuo" and nivel == "medio":
        return True

    return False
