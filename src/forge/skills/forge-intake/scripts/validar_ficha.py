#!/usr/bin/env python3
"""
Validador determinista de la ficha de ejecución de forge-intake.

La ficha es el contrato que el resto del operador ejecuta. Razonar la produce;
este script garantiza que está bien formada antes de emitirla. No interpreta
contenido — solo verifica estructura. Si algo falla, devuelve errores concretos
para que el intake corrija y revalide.

Uso:
    python validar_ficha.py < ficha.json
    python validar_ficha.py ficha.json

Salida: JSON {"valida": bool, "errores": [str], "advertencias": [str],
              "requiere_revision_humana": bool}
Exit code 0 si válida, 1 si no.

requiere_revision_humana es un flag estructurado e ineludible que viaja hasta
el gate de aprobación. Es true cuando la ficha pasa la validación de estructura
pero contiene una combinación que el gate humano DEBE mirar antes de operar
(p. ej. el intake estimó riesgo alto/crítico pero se auto-eximió de aprobación).
El validador no bloquea esa ficha — verificar estructura no es juzgar contenido —
pero tampoco deja que la combinación pase desapercibida: la marca para el humano.
"""

import json
import re
import sys

EJES_TEMPORALES = {"unico", "continuo"}
NATURALEZAS_PASO = {"mecanico", "con-juicio"}
SUFICIENCIAS = {"completa", "requiere_datos", "no_resoluble"}
ACCESOS_FUENTE = {"obvio", "condicional", "dudoso"}
TIPOS_ACCION = {"diagnostico", "planificacion", "ejecucion", "monitoreo", "creacion_capacidad"}
NIVELES_RIESGO = {"bajo", "medio", "alto", "critico"}
FALLBACKS_DESTINO = {"factory", "humano", "no_resoluble"}
ESCALADAS_VALIDAS = {"humano", "no_resoluble"}  # destinos válidos cuando no hay skill ni factory aplicable

# kebab-case: minúsculas y dígitos separados por guiones simples
KEBAB_CASE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

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


def _texto_no_vacio(v):
    return isinstance(v, str) and bool(v.strip())


def validar(ficha):
    errores = []
    advertencias = []
    requiere_revision_humana = False

    if not isinstance(ficha, dict):
        return {"valida": False, "errores": ["La ficha debe ser un objeto JSON."],
                "advertencias": [], "requiere_revision_humana": False}

    for campo in CAMPOS_REQUERIDOS:
        if campo not in ficha:
            errores.append(f"Falta el campo requerido: '{campo}'.")
    if errores:
        return {"valida": False, "errores": errores, "advertencias": advertencias,
                "requiere_revision_humana": False}

    # 1. objetivo
    if not _texto_no_vacio(ficha["objetivo"]):
        errores.append("'objetivo' debe ser una frase no vacía.")

    # 2. datos_requeridos
    dr = ficha["datos_requeridos"]
    if not isinstance(dr, list) or len(dr) == 0:
        errores.append("'datos_requeridos' debe ser una lista con al menos un elemento.")
    else:
        for i, d in enumerate(dr):
            if not _texto_no_vacio(d):
                errores.append(f"datos_requeridos[{i}] debe ser una descripción no vacía.")

    # 3. fuentes_candidatas
    fc = ficha["fuentes_candidatas"]
    if not isinstance(fc, list):
        errores.append("'fuentes_candidatas' debe ser una lista.")
    else:
        for i, f in enumerate(fc):
            if not isinstance(f, dict):
                errores.append(f"fuentes_candidatas[{i}] debe ser un objeto {{fuente, acceso}}.")
                continue
            if not _texto_no_vacio(f.get("fuente", "")):
                errores.append(f"fuentes_candidatas[{i}] necesita 'fuente' no vacía.")
            if f.get("acceso") not in ACCESOS_FUENTE:
                errores.append(
                    f"fuentes_candidatas[{i}].acceso debe ser uno de {sorted(ACCESOS_FUENTE)}, no '{f.get('acceso')}'."
                )

    # 4. eje_temporal
    et = ficha["eje_temporal"]
    tipo_temporal = None  # se captura para la coherencia con tipo_de_accion=monitoreo
    if isinstance(et, dict):
        tipo_temporal = et.get("tipo")
        if tipo_temporal not in EJES_TEMPORALES:
            errores.append(f"eje_temporal.tipo debe ser uno de {sorted(EJES_TEMPORALES)}, no '{tipo_temporal}'.")
        if tipo_temporal == "continuo" and not _texto_no_vacio(et.get("ritmo", "")):
            errores.append("eje_temporal continuo requiere 'ritmo' (cada hora, diario, umbral, etc.).")
    elif isinstance(et, str):
        tipo_temporal = et
        if et not in EJES_TEMPORALES:
            errores.append(f"eje_temporal debe ser uno de {sorted(EJES_TEMPORALES)}, no '{et}'.")
        if et == "continuo":
            errores.append("eje_temporal continuo debe declararse como objeto {tipo, ritmo}, falta el ritmo.")
    else:
        errores.append("eje_temporal debe ser un string o un objeto {tipo, ritmo}.")

    # 5. entregable
    if not _texto_no_vacio(ficha["entregable"]):
        errores.append("'entregable' debe ser una descripción no vacía.")

    # 6. pasos
    pasos = ficha["pasos"]
    if not isinstance(pasos, list) or len(pasos) == 0:
        errores.append("'pasos' debe ser una lista con al menos un paso.")
    else:
        for i, p in enumerate(pasos):
            if not isinstance(p, dict):
                errores.append(f"pasos[{i}] debe ser un objeto {{descripcion, naturaleza}}.")
                continue
            if not _texto_no_vacio(p.get("descripcion", "")):
                errores.append(f"pasos[{i}] necesita 'descripcion' no vacía.")
            if p.get("naturaleza") not in NATURALEZAS_PASO:
                errores.append(
                    f"pasos[{i}].naturaleza debe ser uno de {sorted(NATURALEZAS_PASO)}, no '{p.get('naturaleza')}'."
                )

    # 7. tipo_de_accion
    ta = ficha["tipo_de_accion"]
    if ta not in TIPOS_ACCION:
        errores.append(f"'tipo_de_accion' debe ser uno de {sorted(TIPOS_ACCION)}, no '{ta}'.")
    # Coherencia: monitorear es vigilar en el tiempo — exige eje_temporal continuo.
    if ta == "monitoreo" and tipo_temporal != "continuo":
        errores.append("tipo_de_accion 'monitoreo' exige eje_temporal continuo; un monitoreo no continuo es una contradicción.")

    # 8. riesgo_operativo: {nivel, requiere_aprobacion, razon}
    ro = ficha["riesgo_operativo"]
    if not isinstance(ro, dict):
        errores.append("'riesgo_operativo' debe ser un objeto {nivel, requiere_aprobacion, razon}.")
    else:
        if ro.get("nivel") not in NIVELES_RIESGO:
            errores.append(f"riesgo_operativo.nivel debe ser uno de {sorted(NIVELES_RIESGO)}, no '{ro.get('nivel')}'.")
        if not isinstance(ro.get("requiere_aprobacion"), bool):
            errores.append("riesgo_operativo.requiere_aprobacion debe ser booleano (true/false).")
        if not _texto_no_vacio(ro.get("razon", "")):
            errores.append("riesgo_operativo.razon debe explicar por qué ese nivel.")
        # Salvaguarda: riesgo alto/crítico auto-eximido de aprobación.
        # No es error de estructura — verificar forma no es juzgar contenido, y el
        # gate (no el validador) es la autoridad sobre la aprobación. Pero la
        # combinación no debe pasar desapercibida: se marca con un flag estructurado
        # e ineludible que viaja hasta el gate humano, además de la advertencia.
        if ro.get("nivel") in {"alto", "critico"} and ro.get("requiere_aprobacion") is False:
            requiere_revision_humana = True
            advertencias.append(
                "riesgo_operativo alto/critico con requiere_aprobacion=false: el intake no es la autoridad "
                "sobre la aprobación. Marcado requiere_revision_humana=true para el gate. El skill dice "
                "'ante la duda sube el nivel' — revisa si debería ser true."
            )

    # 9. suficiencia
    suf = ficha["suficiencia"]
    if suf not in SUFICIENCIAS:
        errores.append(f"'suficiencia' debe ser uno de {sorted(SUFICIENCIAS)}, no '{suf}'.")

    # 10. faltantes + coherencia con suficiencia
    faltantes = ficha["faltantes"]
    if not isinstance(faltantes, list):
        errores.append("'faltantes' debe ser una lista (vacía si no aplica).")
    else:
        if suf == "requiere_datos" and len(faltantes) == 0:
            errores.append("suficiencia 'requiere_datos' exige al menos un elemento en 'faltantes'.")
        if suf == "completa" and len(faltantes) > 0:
            advertencias.append("suficiencia 'completa' con 'faltantes' no vacío: revisa si realmente está completa.")
        for i, fl in enumerate(faltantes):
            if not isinstance(fl, dict):
                errores.append(f"faltantes[{i}] debe ser un objeto {{dato, razon}}.")
                continue
            if not _texto_no_vacio(fl.get("dato", "")):
                errores.append(f"faltantes[{i}] necesita 'dato' no vacío.")
            if not _texto_no_vacio(fl.get("razon", "")):
                errores.append(f"faltantes[{i}] necesita 'razon' (por qué se necesita ese dato).")

    # 11. skill_destino_sugerido: {nombre, razon, fallback}
    sd = ficha["skill_destino_sugerido"]
    if not isinstance(sd, dict):
        errores.append("'skill_destino_sugerido' debe ser un objeto {nombre, razon, fallback}.")
    else:
        # nombre puede ser null (ningún skill aplica) o string no vacío en kebab-case
        nombre = sd.get("nombre", "__ausente__")
        if nombre == "__ausente__":
            errores.append("skill_destino_sugerido necesita 'nombre' (null si ningún skill aplica).")
        elif nombre is not None:
            if not _texto_no_vacio(nombre):
                errores.append("skill_destino_sugerido.nombre debe ser null o un nombre no vacío.")
            elif not KEBAB_CASE.match(nombre):
                errores.append(
                    f"skill_destino_sugerido.nombre debe estar en kebab-case (minúsculas, dígitos y guiones), no '{nombre}'."
                )
        if not _texto_no_vacio(sd.get("razon", "")):
            errores.append("skill_destino_sugerido.razon debe explicar el destino.")
        if sd.get("fallback") not in FALLBACKS_DESTINO:
            errores.append(
                f"skill_destino_sugerido.fallback debe ser uno de {sorted(FALLBACKS_DESTINO)}, no '{sd.get('fallback')}'."
            )

    # Coherencia cruzada tipo_de_accion ↔ destino.
    # creacion_capacidad significa que ningún skill cubre el caso: debe ir a factory,
    # sin nombre de skill. Advertir si cualquiera de las dos no cuadra.
    if ta == "creacion_capacidad" and isinstance(sd, dict):
        if sd.get("nombre") is not None or sd.get("fallback") != "factory":
            advertencias.append(
                "tipo_de_accion 'creacion_capacidad' normalmente despacha a factory: "
                "se espera nombre=null y fallback=factory."
            )

    # Coherencia: un problema no_resoluble no puede despacharse a un skill ni a factory
    # (no hay nada que fabricar para algo irresoluble). Debe escalar a humano o no_resoluble.
    if suf == "no_resoluble" and isinstance(sd, dict):
        if sd.get("nombre") is not None or sd.get("fallback") not in ESCALADAS_VALIDAS:
            errores.append(
                "suficiencia 'no_resoluble' exige skill_destino_sugerido sin skill (nombre=null) y "
                f"fallback en {sorted(ESCALADAS_VALIDAS)}; no se fabrica ni se despacha algo irresoluble."
            )

    return {"valida": len(errores) == 0, "errores": errores, "advertencias": advertencias,
            "requiere_revision_humana": requiere_revision_humana}


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()

    try:
        ficha = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"valida": False, "errores": [f"JSON inválido: {e}"],
                          "advertencias": [], "requiere_revision_humana": False}, ensure_ascii=False))
        sys.exit(1)

    resultado = validar(ficha)
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
    sys.exit(0 if resultado["valida"] else 1)


if __name__ == "__main__":
    main()
