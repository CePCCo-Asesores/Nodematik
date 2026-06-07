"""
Validador determinista para el ResultadoExtraccion producido por el orquestador.

Principio: verifica honestidad recalculando — no confía en lo declarado.

Contrato:
  validar_extraccion(resultado: dict, datos_requeridos: list[str]) -> dict
    {
      valida: bool,
      errores: list[str],
      advertencias: list[str],
      cobertura_recalculada_pct: float,
      registros_invalidos: list[int],  # índices de registros con problemas
      requiere_revision_humana: bool
    }
"""

from __future__ import annotations

METODOS_ACCESO_VALIDOS = frozenset({"api", "feed", "web", "archivo_cliente", "dataset_abierto"})
PATRON_REGISTRO_ID = r"^src-\d+:r\d+$"

import re


def validar_extraccion(resultado: dict, datos_requeridos: list) -> dict:
    if not isinstance(resultado, dict):
        return {
            "valida": False,
            "errores": ["ResultadoExtraccion debe ser un objeto JSON."],
            "advertencias": [],
            "cobertura_recalculada_pct": 0.0,
            "registros_invalidos": [],
            "requiere_revision_humana": True,
        }

    errores: list[str] = []
    advertencias: list[str] = []
    registros_invalidos: list[int] = []

    datos_req_set = set(
        str(d).strip() for d in (datos_requeridos or [])
        if isinstance(d, str) and d.strip()
    )

    registros = resultado.get("registros", [])
    if not isinstance(registros, list):
        errores.append("'registros' debe ser una lista.")
        registros = []

    registro_ids_vistos: set[str] = set()
    datos_cubiertos_reales: set[str] = set()

    for i, registro in enumerate(registros):
        invalido = _validar_registro(registro, i, registro_ids_vistos, errores, advertencias)
        if invalido:
            registros_invalidos.append(i)
            continue

        # Acumular datos cubiertos solo de registros válidos
        for dato in registro.get("datos_cubiertos", []):
            dato_str = str(dato).strip()
            if dato_str in datos_req_set:
                datos_cubiertos_reales.add(dato_str)

    # Recalcular cobertura honestamente
    cobertura_recalculada = (
        len(datos_cubiertos_reales) / len(datos_req_set) * 100
        if datos_req_set else 0.0
    )

    # Comparar con lo declarado
    cobertura_declarada = resultado.get("cobertura_pct")
    if cobertura_declarada is not None:
        try:
            diff = abs(float(cobertura_declarada) - cobertura_recalculada)
            if diff > 5.0:
                advertencias.append(
                    f"Cobertura declarada ({cobertura_declarada:.1f}%) difiere de la recalculada "
                    f"({cobertura_recalculada:.1f}%) en más de 5 puntos. "
                    "El orquestador puede tener un bug en el cálculo."
                )
        except (TypeError, ValueError):
            advertencias.append("'cobertura_pct' declarada no es un número válido.")

    # Verificar datos_faltantes declarados vs recalculados
    datos_faltantes_declarados = set(resultado.get("datos_faltantes", []))
    datos_faltantes_reales = datos_req_set - datos_cubiertos_reales
    if datos_faltantes_declarados != datos_faltantes_reales and datos_req_set:
        advertencias.append(
            f"Datos faltantes declarados {sorted(datos_faltantes_declarados)} no coinciden "
            f"con los recalculados {sorted(datos_faltantes_reales)}."
        )

    # Verificar fuentes_usadas coherentes con registros
    fuentes_en_registros = set(
        r.get("fuente") for r in registros
        if isinstance(r, dict) and r.get("fuente")
    )
    fuentes_usadas_declaradas = set(resultado.get("fuentes_usadas", []))
    fuentes_extras = fuentes_en_registros - fuentes_usadas_declaradas
    if fuentes_extras:
        advertencias.append(
            f"Registros referencian fuentes no declaradas en fuentes_usadas: {fuentes_extras}."
        )

    # Campo requerido: extraido_en
    if not resultado.get("extraido_en"):
        errores.append("'extraido_en' (timestamp ISO) es requerido.")

    requiere_revision = bool(resultado.get("requiere_revision_humana", False)) or len(errores) > 0

    return {
        "valida": len(errores) == 0,
        "errores": errores,
        "advertencias": advertencias,
        "cobertura_recalculada_pct": round(cobertura_recalculada, 2),
        "registros_invalidos": registros_invalidos,
        "requiere_revision_humana": requiere_revision,
    }


def _validar_registro(
    registro: dict,
    idx: int,
    ids_vistos: set,
    errores: list,
    advertencias: list,
) -> bool:
    """Valida un único registro. Retorna True si el registro es inválido."""
    if not isinstance(registro, dict):
        errores.append(f"registros[{idx}] debe ser un objeto.")
        return True

    invalido = False

    # registro_id: formato "src-N:rM", único
    rid = registro.get("registro_id", "")
    if not rid:
        errores.append(f"registros[{idx}] falta 'registro_id'.")
        invalido = True
    elif not re.match(PATRON_REGISTRO_ID, rid):
        errores.append(
            f"registros[{idx}].registro_id '{rid}' no sigue el formato 'src-N:rM'."
        )
        invalido = True
    elif rid in ids_vistos:
        errores.append(f"registros[{idx}].registro_id '{rid}' duplicado.")
        invalido = True
    else:
        ids_vistos.add(rid)

    # contenido no vacío
    contenido = registro.get("contenido", "")
    if not isinstance(contenido, str) or not contenido.strip():
        errores.append(f"registros[{idx}] (id='{rid}') 'contenido' no puede estar vacío.")
        invalido = True

    # fuente presente
    fuente = registro.get("fuente", "")
    if not isinstance(fuente, str) or not fuente.strip():
        errores.append(f"registros[{idx}] (id='{rid}') falta 'fuente'.")
        invalido = True

    # metodo_acceso válido
    metodo = registro.get("metodo_acceso")
    if metodo not in METODOS_ACCESO_VALIDOS:
        errores.append(
            f"registros[{idx}] (id='{rid}') metodo_acceso '{metodo}' inválido."
        )
        invalido = True

    # datos_cubiertos es lista
    dtc = registro.get("datos_cubiertos")
    if not isinstance(dtc, list):
        errores.append(f"registros[{idx}] (id='{rid}') 'datos_cubiertos' debe ser una lista.")
        invalido = True

    # obtenido_en presente
    if not registro.get("obtenido_en"):
        advertencias.append(f"registros[{idx}] (id='{rid}') falta 'obtenido_en' (timestamp).")

    return invalido
