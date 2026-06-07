#!/usr/bin/env python3
"""
Validador determinista de la salida de forge-extract.

La salida de extracción es lo que el análisis consume y lo que el audit log registra.
Este script verifica que esté bien formada y que sea HONESTA contra el plan:
no basta con que el modelo diga "extracción completa" — se recalcula desde los
registros reales y se compara. Igual que validar_plan.py demuestra la cobertura
en vez de confiarla.

Necesita dos inputs: la salida de extracción Y el plan original (de forge-sources),
porque la honestidad solo se puede verificar contra lo que el plan declaró usable.

Uso:
    python validar_extraccion.py salida.json plan.json

Salida: JSON {"valida": bool, "errores": [str], "advertencias": [str]}
Exit code 0 si válida, 1 si no.
"""

import json
import sys

ESTADOS_FUENTE = {"ok", "parcial", "error", "degradado", "omitida"}
CAMPOS_REGISTRO = {"contenido", "fuente", "metodo_acceso", "registro_id", "datos_cubiertos", "metadatos", "obtenido_en"}
USABLES = {"disponible", "condicional"}


def _texto_no_vacio(v):
    return isinstance(v, str) and bool(v.strip())


def validar(salida, plan):
    errores = []
    advertencias = []

    if not isinstance(salida, dict):
        return {"valida": False, "errores": ["La salida debe ser un objeto JSON."], "advertencias": [], "requiere_revision_humana": False}

    for campo in ("registros", "resultados_por_fuente", "resumen_extraccion"):
        if campo not in salida:
            errores.append(f"Falta el bloque '{campo}'.")
    if errores:
        return {"valida": False, "errores": errores, "advertencias": advertencias, "requiere_revision_humana": False}

    registros = salida["registros"]
    traza = salida["resultados_por_fuente"]
    resumen = salida["resumen_extraccion"]

    # ── 1. Cada registro tiene todos los campos del schema común ──
    if not isinstance(registros, list):
        errores.append("'registros' debe ser una lista.")
        registros = []
    for i, r in enumerate(registros):
        if not isinstance(r, dict):
            errores.append(f"registros[{i}] debe ser un objeto.")
            continue
        faltan = CAMPOS_REGISTRO - set(r.keys())
        if faltan:
            errores.append(f"registros[{i}] le faltan campos del schema: {sorted(faltan)}.")
        if "contenido" in r and not _texto_no_vacio(r["contenido"]):
            errores.append(f"registros[{i}].contenido no puede estar vacío.")
        if "obtenido_en" in r and not _texto_no_vacio(r.get("obtenido_en")):
            errores.append(f"registros[{i}].obtenido_en debe tener timestamp (lo sella el orquestador).")

    # ── 2. Traza por fuente bien formada ──
    if not isinstance(traza, list):
        errores.append("'resultados_por_fuente' debe ser una lista.")
        traza = []
    traza_por_clave = {}
    claves_vistas = []
    # contadores recalculados desde la traza para comparar contra el resumen
    recalc = {"ok": 0, "degradado": 0, "error": 0, "omitida": 0, "parcial": 0}
    for i, t in enumerate(traza):
        if not isinstance(t, dict):
            errores.append(f"resultados_por_fuente[{i}] debe ser un objeto.")
            continue
        est = t.get("estado")
        if est not in ESTADOS_FUENTE:
            errores.append(f"resultados_por_fuente[{i}].estado inválido: '{est}'.")
        if not isinstance(t.get("registros_obtenidos"), int):
            errores.append(f"resultados_por_fuente[{i}].registros_obtenidos debe ser entero.")
        if est in recalc:
            recalc[est] += 1
        # id estable como llave; fallback al nombre (igual que el orquestador)
        clave = t.get("id") or t.get("fuente")
        if clave in claves_vistas:
            errores.append(f"La fuente '{clave}' aparece más de una vez en resultados_por_fuente (debe ser única).")
        claves_vistas.append(clave)
        traza_por_clave[clave] = t

    # ── 3. Verificación de honestidad contra el plan ──
    if not isinstance(plan, dict) or "fuentes" not in plan:
        errores.append("El plan de referencia es inválido; no se puede verificar honestidad.")
    else:
        for f in plan["fuentes"]:
            clave = f.get("id") or f.get("fuente")
            nombre = f.get("fuente")
            estado_plan = f.get("estado")
            t = traza_por_clave.get(clave)

            # 3a. Toda fuente del plan debe aparecer en la traza
            if t is None:
                errores.append(f"La fuente '{nombre}' del plan no aparece en resultados_por_fuente.")
                continue

            # 3b. Descartada/dudosa: omitida, sin registros, y omitida_por='prohibida'
            if estado_plan not in USABLES:
                if t.get("estado") != "omitida":
                    errores.append(
                        f"La fuente '{nombre}' está '{estado_plan}' en el plan pero su estado de extracción "
                        f"es '{t.get('estado')}': una fuente no usable debe ser 'omitida', no intentarse."
                    )
                if t.get("registros_obtenidos", 0) > 0:
                    errores.append(
                        f"La fuente '{nombre}' es '{estado_plan}' (no usable) pero tiene registros: "
                        f"se extrajo algo que no debía tocarse."
                    )
                if t.get("estado") == "omitida" and t.get("omitida_por") != "prohibida":
                    errores.append(
                        f"La fuente '{nombre}' ('{estado_plan}') debe declarar omitida_por='prohibida', "
                        f"no '{t.get('omitida_por')}'."
                    )

            # 3c. Condicional omitida: debe declarar omitida_por='pendiente_credencial'
            if estado_plan == "condicional" and t.get("estado") == "omitida":
                if t.get("omitida_por") != "pendiente_credencial":
                    errores.append(
                        f"La fuente condicional '{nombre}' omitida debe declarar "
                        f"omitida_por='pendiente_credencial', no '{t.get('omitida_por')}'."
                    )

    # ── 4. El resumen cuadra con los datos reales ──
    if not isinstance(resumen, dict):
        errores.append("'resumen_extraccion' debe ser un objeto.")
    else:
        # total_registros cuadra con la lista real
        if resumen.get("total_registros") != len(registros):
            errores.append(
                f"resumen.total_registros={resumen.get('total_registros')} no cuadra con la cantidad real "
                f"de registros ({len(registros)})."
            )

        # Recalcular los contadores de fuente desde la traza y comparar.
        # fuentes_ok agrupa ok+parcial (éxito con datos); degradado y error/omitida aparte.
        esperado = {
            "fuentes_ok": recalc["ok"] + recalc["parcial"],
            "fuentes_degradadas": recalc["degradado"],
            "fuentes_error": recalc["error"],
            "fuentes_omitidas": recalc["omitida"],
        }
        for campo, val in esperado.items():
            if campo in resumen and resumen[campo] != val:
                errores.append(
                    f"resumen.{campo}={resumen[campo]} no cuadra con lo recalculado desde la traza ({val})."
                )

        # datos_cubiertos recalculados desde los registros reales, FILTRADOS a requeridos
        # (coherente con el orquestador: datos extra no cuentan para cobertura).
        requeridos = set()
        if isinstance(plan, dict):
            requeridos = {d.strip() for d in plan.get("datos_requeridos", []) if _texto_no_vacio(d)}

        cubiertos_real = set()
        for r in registros:
            if isinstance(r, dict):
                for d in r.get("datos_cubiertos", []):
                    if _texto_no_vacio(d):
                        cubiertos_real.add(d.strip())
        cubiertos_real = cubiertos_real & requeridos  # solo lo requerido cuenta como cobertura

        declarado_cubiertos = {d.strip() for d in resumen.get("datos_cubiertos", []) if _texto_no_vacio(d)}
        if declarado_cubiertos != cubiertos_real:
            errores.append(
                f"resumen.datos_cubiertos no coincide con lo recalculado (filtrado a requeridos). "
                f"Declarado: {sorted(declarado_cubiertos)}, real: {sorted(cubiertos_real)}."
            )

        # extraccion_completa: SOLO true si todos los datos_requeridos tienen registros reales
        if requeridos:
            completa_real = requeridos.issubset(cubiertos_real)
            sin_extraer_real = sorted(requeridos - cubiertos_real)

            if resumen.get("extraccion_completa") != completa_real:
                if completa_real:
                    errores.append("resumen.extraccion_completa=false pero todos los datos requeridos tienen registros: debería ser true.")
                else:
                    errores.append(
                        f"resumen.extraccion_completa=true pero faltan datos sin registros reales: "
                        f"{sin_extraer_real}. Debería ser false."
                    )

            declarado_sin = {d.strip() for d in resumen.get("datos_sin_extraer", []) if _texto_no_vacio(d)}
            if declarado_sin != set(sin_extraer_real):
                errores.append(
                    f"resumen.datos_sin_extraer no coincide con lo recalculado. "
                    f"Declarado: {sorted(declarado_sin)}, real: {sin_extraer_real}."
                )
        else:
            advertencias.append("El plan no trae datos_requeridos; no se pudo verificar extraccion_completa.")

    # requiere_revision_humana se propaga desde el plan (la señal de riesgo nace en
    # forge-sources, que evaluó las fuentes). El validador de extracción no la recalcula
    # —no es su trabajo juzgar riesgo— pero la propaga para que la forma de salida de
    # todos los validadores de la cadena sea uniforme y forge-analyze pueda leerla.
    revision = False
    if isinstance(plan, dict):
        # el plan no lleva el flag directo, pero una fuente usada de riesgo alto/critico lo implica
        for f in plan.get("fuentes", []):
            if f.get("estado") in ("disponible", "condicional") and f.get("riesgo_fuente") in ("alto", "critico"):
                revision = True
                break

    return {"valida": len(errores) == 0, "errores": errores, "advertencias": advertencias,
            "requiere_revision_humana": revision}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"valida": False,
                          "errores": ["Uso: python validar_extraccion.py salida.json plan.json"],
                          "advertencias": [], "requiere_revision_humana": False}, ensure_ascii=False))
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        salida = json.load(fh)
    with open(sys.argv[2], "r", encoding="utf-8") as fh:
        plan = json.load(fh)

    resultado = validar(salida, plan)
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
    sys.exit(0 if resultado["valida"] else 1)


if __name__ == "__main__":
    main()
