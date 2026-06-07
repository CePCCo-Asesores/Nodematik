"""
Validador determinista para el PLAN producido por forge-sources.

Principio: DEMUESTRA cobertura recalculando desde cero.
No confía en lo que el LLM declara — recalcula y compara.

Contrato:
  validar_plan(plan: dict, datos_requeridos: list[str]) -> dict
    {
      valida: bool,
      errores: list[str],
      advertencias: list[str],
      cobertura_recalculada_pct: float,
      datos_cubiertos_recalculados: list[str],
      datos_faltantes_recalculados: list[str],
      requiere_revision_humana: bool
    }
"""

from __future__ import annotations

ESTADOS_VALIDOS = frozenset({"disponible", "condicional", "descartada", "dudosa"})
METODOS_ACCESO_VALIDOS = frozenset({"api", "feed", "web", "archivo_cliente", "dataset_abierto"})


def validar_plan(plan: dict, datos_requeridos: list) -> dict:
    if not isinstance(plan, dict):
        return {
            "valida": False,
            "errores": ["El PLAN debe ser un objeto JSON."],
            "advertencias": [],
            "cobertura_recalculada_pct": 0.0,
            "datos_cubiertos_recalculados": [],
            "datos_faltantes_recalculados": list(datos_requeridos) if isinstance(datos_requeridos, list) else [],
            "requiere_revision_humana": True,
        }

    if not isinstance(datos_requeridos, list) or len(datos_requeridos) == 0:
        return {
            "valida": False,
            "errores": ["'datos_requeridos' debe ser una lista no vacía para calcular cobertura."],
            "advertencias": [],
            "cobertura_recalculada_pct": 0.0,
            "datos_cubiertos_recalculados": [],
            "datos_faltantes_recalculados": [],
            "requiere_revision_humana": True,
        }

    errores: list[str] = []
    advertencias: list[str] = []

    fuentes = plan.get("fuentes", [])
    if not isinstance(fuentes, list):
        errores.append("'plan.fuentes' debe ser una lista.")
        fuentes = []

    ids_vistos: set[str] = set()
    for i, fuente in enumerate(fuentes):
        _validar_fuente(fuente, i, ids_vistos, errores, advertencias)

    # Recalcular cobertura desde cero — no confiar en lo declarado
    datos_req_set = set(str(d).strip() for d in datos_requeridos if isinstance(d, str) and d.strip())
    datos_cubiertos_reales: set[str] = set()

    for fuente in fuentes:
        if not isinstance(fuente, dict):
            continue
        if fuente.get("estado") != "disponible":
            continue
        datos_que_cubre = fuente.get("datos_que_cubre", [])
        if isinstance(datos_que_cubre, list):
            for dato in datos_que_cubre:
                dato_str = str(dato).strip()
                if dato_str in datos_req_set:
                    datos_cubiertos_reales.add(dato_str)

    datos_faltantes_reales = sorted(datos_req_set - datos_cubiertos_reales)
    cobertura_pct = (
        len(datos_cubiertos_reales) / len(datos_req_set) * 100
        if datos_req_set else 0.0
    )

    # Comparar con cobertura declarada en el plan
    cobertura_declarada = plan.get("cobertura_pct")
    if cobertura_declarada is not None:
        try:
            diff = abs(float(cobertura_declarada) - cobertura_pct)
            if diff > 5.0:
                advertencias.append(
                    f"Cobertura declarada ({cobertura_declarada:.1f}%) difiere de la recalculada "
                    f"({cobertura_pct:.1f}%) en más de 5 puntos porcentuales. Usar la recalculada."
                )
        except (TypeError, ValueError):
            advertencias.append("'plan.cobertura_pct' no es un número válido.")

    # Al menos una fuente disponible
    fuentes_disponibles = [f for f in fuentes if isinstance(f, dict) and f.get("estado") == "disponible"]
    if len(fuentes_disponibles) == 0:
        errores.append("El PLAN no tiene ninguna fuente con estado 'disponible'. No se puede extraer nada.")

    # Datos sin cobertura
    if datos_faltantes_reales:
        advertencias.append(
            f"Datos requeridos sin fuente disponible: {datos_faltantes_reales}. "
            "Considerar agregar fuentes condicionales o revisar con el cliente."
        )

    # Fuentes dudosas sin acción
    fuentes_dudosas = [f for f in fuentes if isinstance(f, dict) and f.get("estado") == "dudosa"]
    if fuentes_dudosas:
        ids_dudosas = [f.get("id", f"[{i}]") for i, f in enumerate(fuentes_dudosas)]
        advertencias.append(
            f"Fuentes dudosas que requieren aclaración del cliente: {ids_dudosas}."
        )

    requiere_revision = _evaluar_revision_humana(plan, errores, cobertura_pct, fuentes)

    return {
        "valida": len(errores) == 0,
        "errores": errores,
        "advertencias": advertencias,
        "cobertura_recalculada_pct": round(cobertura_pct, 2),
        "datos_cubiertos_recalculados": sorted(datos_cubiertos_reales),
        "datos_faltantes_recalculados": datos_faltantes_reales,
        "requiere_revision_humana": requiere_revision,
    }


def _validar_fuente(
    fuente: dict, idx: int, ids_vistos: set, errores: list, advertencias: list
) -> None:
    if not isinstance(fuente, dict):
        errores.append(f"fuentes[{idx}] debe ser un objeto.")
        return

    # id único y presente
    fuente_id = fuente.get("id")
    if not fuente_id or not isinstance(fuente_id, str) or not fuente_id.strip():
        errores.append(f"fuentes[{idx}] falta campo 'id' (string no vacío, estable y único).")
    else:
        if fuente_id in ids_vistos:
            errores.append(f"fuentes[{idx}] id duplicado: '{fuente_id}'.")
        ids_vistos.add(fuente_id)
        # Advertir si el id parece ser una URL (inestable)
        if fuente_id.startswith("http://") or fuente_id.startswith("https://"):
            advertencias.append(
                f"fuentes['{fuente_id}'].id parece ser una URL — usar un nombre semántico estable en su lugar."
            )

    # estado válido
    estado = fuente.get("estado")
    if estado not in ESTADOS_VALIDOS:
        errores.append(
            f"fuentes['{fuente_id}'].estado inválido: '{estado}'. "
            f"Valores válidos: {sorted(ESTADOS_VALIDOS)}."
        )

    # metodo_acceso solo en disponible/condicional
    metodo = fuente.get("metodo_acceso")
    if estado in ("disponible", "condicional"):
        if metodo not in METODOS_ACCESO_VALIDOS and metodo is not None:
            errores.append(
                f"fuentes['{fuente_id}'].metodo_acceso inválido: '{metodo}'. "
                f"Valores válidos: {sorted(METODOS_ACCESO_VALIDOS)}."
            )
        if metodo is None and estado == "disponible":
            errores.append(
                f"fuentes['{fuente_id}'] con estado 'disponible' requiere metodo_acceso."
            )

    # datos_que_cubre presente para fuentes disponibles
    if estado == "disponible":
        dtc = fuente.get("datos_que_cubre", [])
        if not isinstance(dtc, list) or len(dtc) == 0:
            advertencias.append(
                f"fuentes['{fuente_id}'] con estado 'disponible' no declara 'datos_que_cubre' — "
                "no contribuirá al cálculo de cobertura."
            )

    # condicional debe declarar qué requiere del cliente
    if estado == "condicional":
        rdel = fuente.get("requiere_del_cliente")
        if not rdel or (isinstance(rdel, str) and not rdel.strip()):
            errores.append(
                f"fuentes['{fuente_id}'] con estado 'condicional' debe declarar "
                "'requiere_del_cliente' — el orquestador necesita saber qué pedirle al cliente."
            )

    # nota_permiso para fuentes web (verificación robots.txt/ToS)
    if metodo == "web" and estado == "disponible":
        if not fuente.get("nota_permiso"):
            advertencias.append(
                f"fuentes['{fuente_id}'] usa metodo 'web' — documentar verificación de robots.txt "
                "y términos de servicio en 'nota_permiso'."
            )


def _evaluar_revision_humana(
    plan: dict, errores: list, cobertura_pct: float, fuentes: list
) -> bool:
    if errores:
        return True

    # Cobertura baja sobre datos críticos
    if cobertura_pct < 50.0:
        return True

    # Alguna fuente señala riesgo alto
    for fuente in fuentes:
        if not isinstance(fuente, dict):
            continue
        riesgo = fuente.get("riesgo_fuente", "")
        if isinstance(riesgo, str) and riesgo.lower() in ("alto", "critico"):
            return True

    # El plan mismo declara revisión requerida
    if plan.get("requiere_revision_humana"):
        return True

    return False
