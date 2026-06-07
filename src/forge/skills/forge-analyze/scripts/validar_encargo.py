#!/usr/bin/env python3
"""
Validador determinista del encargo de fabricación de forge-analyze.

El encargo es el contrato que la FACTORY ejecuta. Razonar lo produce; este script
garantiza que es coherente antes de emitirlo. No juzga si la decisión reusar/modificar/
fabricar es la correcta (eso es contenido) — verifica que la estructura y las reglas
de gobernanza se cumplan: que un skill nuevo o modificado nunca quede aprobado por
herencia, que las cinco variables estén cuando se fabrica, que el riesgo alto escale.

Uso:
    python validar_encargo.py encargo.json

Salida: JSON {"valida": bool, "errores": [str], "advertencias": [str]}
Exit code 0 si válida, 1 si no.
"""

import json
import sys

DECISIONES = {"reusar", "modificar", "fabricar"}
NIVELES_RIESGO = {"bajo", "medio", "alto", "critico"}
NIVELES_GENERALIZACION = {"cliente", "vertical", "universal"}
CINCO_VARIABLES = {"verbo_central", "señal_disparo", "formato_salida", "complejidad", "distincion"}


def _texto_no_vacio(v):
    return isinstance(v, str) and bool(v.strip())


def validar(encargo):
    errores = []
    advertencias = []

    if not isinstance(encargo, dict):
        return {"valida": False, "errores": ["El encargo debe ser un objeto JSON."], "advertencias": []}

    # Campos base
    for campo in ("decision", "justificacion", "basado_en_datos_completos",
                  "riesgo_acumulado", "reaprobacion_requerida", "requiere_revision_humana",
                  "evidencia_usada", "nivel_generalizacion"):
        if campo not in encargo:
            errores.append(f"Falta el campo requerido: '{campo}'.")
    if errores:
        return {"valida": False, "errores": errores, "advertencias": advertencias}

    decision = encargo["decision"]
    if decision not in DECISIONES:
        errores.append(f"'decision' debe ser una de {sorted(DECISIONES)}, no '{decision}'.")

    if not _texto_no_vacio(encargo["justificacion"]):
        errores.append("'justificacion' no puede estar vacía: debe explicar por qué ese camino.")

    skill_objetivo = encargo.get("skill_objetivo")
    espec = encargo.get("especificacion_factory")
    modificaciones = encargo.get("modificaciones")

    # ── Reglas por decisión ──
    if decision == "fabricar":
        # Skill nuevo: no apunta a uno existente.
        if skill_objetivo is not None:
            errores.append("decision 'fabricar' exige skill_objetivo=null (no se basa en un skill existente).")
        # Necesita las cinco variables.
        _verificar_cinco_variables(espec, errores)

    elif decision == "modificar":
        # Necesita el skill a modificar y qué modificar.
        if not _texto_no_vacio(skill_objetivo):
            errores.append("decision 'modificar' exige 'skill_objetivo' (el skill aprobado a extender).")
        if not isinstance(modificaciones, list) or len(modificaciones) == 0:
            errores.append("decision 'modificar' exige 'modificaciones' (lista no vacía de ajustes).")
        # Necesita la especificación de cómo queda tras modificar.
        _verificar_cinco_variables(espec, errores)

    elif decision == "reusar":
        # Reusar no fabrica nada: no debe traer especificación de fabricación.
        if espec not in (None, {}, ):
            if isinstance(espec, dict) and any(espec.get(k) for k in CINCO_VARIABLES):
                advertencias.append("decision 'reusar' no debería traer especificacion_factory con contenido (no se fabrica nada).")
        if not _texto_no_vacio(skill_objetivo):
            errores.append("decision 'reusar' exige 'skill_objetivo' (el skill aprobado a parametrizar).")
        # Reusar conviene que declare con qué parámetros se invoca.
        if "parametros" not in encargo or not isinstance(encargo.get("parametros"), dict):
            advertencias.append("decision 'reusar' debería declarar 'parametros' (con qué se invoca el skill existente).")

    # ── Gobernanza: modificar/fabricar SIEMPRE re-aprueban ──
    reaprob = encargo["reaprobacion_requerida"]
    if not isinstance(reaprob, bool):
        errores.append("'reaprobacion_requerida' debe ser booleano.")
    elif decision in {"modificar", "fabricar"} and reaprob is not True:
        errores.append(
            f"decision '{decision}' exige reaprobacion_requerida=true: un skill nuevo o modificado nunca "
            f"queda aprobado por herencia. Su comportamiento cambió y debe re-aprobarse."
        )

    # ── Honestidad sobre datos ──
    completos = encargo["basado_en_datos_completos"]
    if not isinstance(completos, bool):
        errores.append("'basado_en_datos_completos' debe ser booleano.")
    elif completos is False:
        faltantes = encargo.get("datos_faltantes")
        if not isinstance(faltantes, list) or len(faltantes) == 0:
            errores.append("Si basado_en_datos_completos=false, 'datos_faltantes' debe listar qué faltó.")

    # ── Riesgo acumulado y escalamiento ──
    riesgo = encargo["riesgo_acumulado"]
    nivel = None
    if not isinstance(riesgo, dict):
        errores.append("'riesgo_acumulado' debe ser un objeto {nivel, fuentes_del_riesgo}.")
    else:
        nivel = riesgo.get("nivel")
        if nivel not in NIVELES_RIESGO:
            errores.append(f"riesgo_acumulado.nivel debe ser uno de {sorted(NIVELES_RIESGO)}, no '{nivel}'.")

    revision = encargo["requiere_revision_humana"]
    if not isinstance(revision, bool):
        errores.append("'requiere_revision_humana' debe ser booleano.")
    elif nivel in {"alto", "critico"} and revision is not True:
        errores.append(
            f"riesgo_acumulado nivel '{nivel}' exige requiere_revision_humana=true: una capacidad de "
            f"riesgo alto/crítico debe revisarse antes de aprobarse."
        )

    # ── evidencia_usada: trazabilidad causal ──
    evidencia = encargo["evidencia_usada"]
    if not isinstance(evidencia, list):
        errores.append("'evidencia_usada' debe ser una lista.")
    else:
        # Reusar puede no necesitar evidencia (no se fabrica nada nuevo); modificar/fabricar sí,
        # porque están pidiendo construir capacidad y deben justificarla con datos.
        if decision in {"modificar", "fabricar"} and len(evidencia) == 0:
            advertencias.append(
                "decision '" + str(decision) + "' sin evidencia_usada: la FACTORY recibe una conclusión sin "
                "trazabilidad de qué datos la justifican. Enlaza al menos un registro."
            )
        for i, ev in enumerate(evidencia):
            if not isinstance(ev, dict):
                errores.append(f"evidencia_usada[{i}] debe ser un objeto {{registro_id, fuente, razon}}.")
                continue
            if not _texto_no_vacio(ev.get("registro_id", "")):
                errores.append(f"evidencia_usada[{i}] necesita 'registro_id' (enlace al registro del extractor).")
            if not _texto_no_vacio(ev.get("razon", "")):
                errores.append(f"evidencia_usada[{i}] necesita 'razon' (por qué ese dato justifica la spec).")

    # ── nivel_generalizacion: alcance y rigor ──
    nivel_gen = encargo["nivel_generalizacion"]
    if nivel_gen not in NIVELES_GENERALIZACION:
        errores.append(f"'nivel_generalizacion' debe ser uno de {sorted(NIVELES_GENERALIZACION)}, no '{nivel_gen}'.")
    elif nivel_gen == "universal" and decision in {"modificar", "fabricar"} and revision is not True:
        # Un skill universal tiene radio de impacto = todo el ecosistema. Aunque el riesgo
        # operativo parezca bajo, su alcance exige revisión humana antes de aprobar.
        errores.append(
            "nivel_generalizacion 'universal' al fabricar/modificar exige requiere_revision_humana=true: "
            "un skill universal impacta todo el ecosistema, su aprobación no puede ser automática."
        )

    return {"valida": len(errores) == 0, "errores": errores, "advertencias": advertencias}


def _verificar_cinco_variables(espec, errores):
    if not isinstance(espec, dict):
        errores.append("especificacion_factory debe ser un objeto con las cinco variables de la FACTORY.")
        return
    for v in sorted(CINCO_VARIABLES):
        if not _texto_no_vacio(espec.get(v, "")):
            errores.append(f"especificacion_factory.{v} es necesaria para que la FACTORY fabrique bien.")


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"valida": False, "errores": ["Uso: python validar_encargo.py encargo.json"],
                          "advertencias": []}, ensure_ascii=False))
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        encargo = json.load(fh)
    resultado = validar(encargo)
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
    sys.exit(0 if resultado["valida"] else 1)


if __name__ == "__main__":
    main()
