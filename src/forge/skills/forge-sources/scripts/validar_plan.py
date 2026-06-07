#!/usr/bin/env python3
"""
Validador determinista del plan de fuentes de forge-sources.

El plan es el contrato que el skill de extracción ejecuta. Razonar lo produce;
este script garantiza que está bien formado y coherente antes de emitirlo.
No juzga si una decisión de "permitido" es correcta — eso es contenido, no forma.
Verifica estructura, valores válidos, coherencia interna, que el resumen cuadre
con el detalle, y que cobertura_datos sea coherente con los estados.

Uso:
    python validar_plan.py < plan.json
    python validar_plan.py plan.json

Salida: JSON {"valida": bool, "errores": [str], "advertencias": [str],
              "requiere_revision_humana": bool}
Exit code 0 si válida, 1 si no.

requiere_revision_humana se marca true cuando una fuente disponible/condicional
tiene riesgo_fuente alto/critico: el plan es estructuralmente válido, pero esa
combinación debe llegar marcada al gate humano, no pasar como trivial. Misma
semántica que el flag del intake: el validador no bloquea contenido, pero no deja
que lo delicado pase desapercibido.
"""

import json
import sys

ESTADOS = {"disponible", "condicional", "descartada", "dudosa"}
METODOS = {"api", "feed", "web", "archivo_cliente", "dataset_abierto", None}
NIVELES_RIESGO = {"bajo", "medio", "alto", "critico"}
EXIGEN_RAZON = {"descartada", "dudosa", "condicional"}
USABLES = {"disponible", "condicional"}


def _texto_no_vacio(v):
    return isinstance(v, str) and bool(v.strip())


def validar(plan):
    errores = []
    advertencias = []
    requiere_revision_humana = False

    if not isinstance(plan, dict):
        return {"valida": False, "errores": ["El plan debe ser un objeto JSON."],
                "advertencias": [], "requiere_revision_humana": False}

    for campo in ("fuentes", "resumen", "cobertura_datos", "datos_requeridos"):
        if campo not in plan:
            errores.append(f"Falta el campo '{campo}'.")
    if errores:
        return {"valida": False, "errores": errores, "advertencias": advertencias,
                "requiere_revision_humana": False}

    fuentes = plan["fuentes"]
    if not isinstance(fuentes, list):
        errores.append("'fuentes' debe ser una lista.")
        return {"valida": False, "errores": errores, "advertencias": advertencias,
                "requiere_revision_humana": False}

    conteo = {"disponible": 0, "condicional": 0, "descartada": 0, "dudosa": 0}
    datos_por_disponible = set()   # datos cubiertos por fuentes disponibles
    datos_por_condicional = set()  # datos cubiertos solo por condicionales
    ids_vistos = []                # para detectar ids duplicados

    # Qué clave de metadatos necesita cada método para que el extractor pueda llegar a la fuente.
    METADATO_REQUERIDO = {
        "feed": "url",
        "web": "url",
        "api": "endpoint",
        "archivo_cliente": "ruta",
        "dataset_abierto": "url",
    }

    for i, f in enumerate(fuentes):
        if not isinstance(f, dict):
            errores.append(f"fuentes[{i}] debe ser un objeto.")
            continue

        if not _texto_no_vacio(f.get("fuente", "")):
            errores.append(f"fuentes[{i}] necesita 'fuente' no vacía.")

        # id estable y único: el extractor lo usa como llave de credenciales y trazabilidad.
        fid = f.get("id")
        if not _texto_no_vacio(fid):
            errores.append(f"fuentes[{i}] necesita 'id' estable y no vacío (p.ej. src-{i+1}).")
        elif fid in ids_vistos:
            errores.append(f"fuentes[{i}].id='{fid}' está duplicado; cada fuente necesita un id único.")
        else:
            ids_vistos.append(fid)

        estado = f.get("estado")
        if estado not in ESTADOS:
            errores.append(f"fuentes[{i}].estado debe ser uno de {sorted(ESTADOS)}, no '{estado}'.")
        else:
            conteo[estado] += 1

        metodo = f.get("metodo_acceso", "__ausente__")
        if metodo == "__ausente__":
            errores.append(f"fuentes[{i}] necesita 'metodo_acceso' (null si descartada/dudosa).")
        elif metodo not in METODOS:
            errores.append(f"fuentes[{i}].metodo_acceso inválido: '{metodo}'.")

        if estado in USABLES and metodo in (None, "__ausente__"):
            errores.append(f"fuentes[{i}] en estado '{estado}' requiere un metodo_acceso real (no null).")

        # metadatos: contrato con el extractor. Para fuentes usables, debe traer el dato
        # de acceso que su método necesita (url/endpoint/ruta), o el extractor no sabrá
        # de dónde extraer. Para descartada/dudosa puede ir vacío (no se extraen).
        meta = f.get("metadatos")
        if estado in USABLES:
            if not isinstance(meta, dict):
                errores.append(f"fuentes[{i}] usable necesita 'metadatos' (objeto con los datos de acceso).")
            elif metodo in METADATO_REQUERIDO:
                clave = METADATO_REQUERIDO[metodo]
                if not _texto_no_vacio(meta.get(clave, "")):
                    errores.append(
                        f"fuentes[{i}] ('{metodo}') necesita metadatos.{clave} para que el extractor "
                        f"sepa de dónde obtener los datos."
                    )

        if estado in EXIGEN_RAZON and not _texto_no_vacio(f.get("razon", "")):
            errores.append(f"fuentes[{i}] en estado '{estado}' exige 'razon' no vacía.")

        if estado == "condicional" and not _texto_no_vacio(f.get("requiere_del_cliente", "")):
            errores.append(f"fuentes[{i}] condicional exige 'requiere_del_cliente'.")

        if estado == "disponible" and _texto_no_vacio(f.get("requiere_del_cliente", "")):
            advertencias.append(f"fuentes[{i}] 'disponible' declara requiere_del_cliente: ¿debería ser 'condicional'?")

        if not _texto_no_vacio(f.get("nota_permiso", "")):
            errores.append(f"fuentes[{i}] necesita 'nota_permiso'.")

        # riesgo_fuente: válido en toda fuente; flag si usable y alto/critico
        riesgo = f.get("riesgo_fuente")
        if riesgo not in NIVELES_RIESGO:
            errores.append(f"fuentes[{i}].riesgo_fuente debe ser uno de {sorted(NIVELES_RIESGO)}, no '{riesgo}'.")
        elif estado in USABLES and riesgo in {"alto", "critico"}:
            requiere_revision_humana = True
            advertencias.append(
                f"fuentes[{i}] usable con riesgo_fuente '{riesgo}': marcada requiere_revision_humana=true para el gate."
            )

        dc = f.get("datos_que_cubre", [])
        if not isinstance(dc, list):
            errores.append(f"fuentes[{i}].datos_que_cubre debe ser una lista.")
        else:
            for d in dc:
                if _texto_no_vacio(d):
                    if estado == "disponible":
                        datos_por_disponible.add(d.strip())
                    elif estado == "condicional":
                        datos_por_condicional.add(d.strip())
            # Regla explícita: una fuente descartada o dudosa NO cubre datos para
            # efectos de cobertura, aunque liste datos_que_cubre. Se permite que los
            # liste (información), pero no cuentan — y se advierte para que el modelo
            # no crea que esos datos están cubiertos.
            if estado in {"descartada", "dudosa"} and len(dc) > 0:
                advertencias.append(
                    f"fuentes[{i}] está '{estado}' y declara datos_que_cubre: esos datos NO cuentan para la "
                    f"cobertura (la fuente no es usable). Verifica que no los estés contando como cubiertos."
                )

    # Resumen cuadra con conteo
    resumen = plan["resumen"]
    if not isinstance(resumen, dict):
        errores.append("'resumen' debe ser un objeto.")
    else:
        mapa = {
            "fuentes_disponibles": "disponible",
            "fuentes_condicionales": "condicional",
            "fuentes_descartadas": "descartada",
            "fuentes_dudosas": "dudosa",
        }
        for campo, estado in mapa.items():
            if campo not in resumen:
                errores.append(f"resumen necesita '{campo}'.")
            elif resumen[campo] != conteo[estado]:
                errores.append(f"resumen.{campo}={resumen[campo]} no cuadra con el conteo real ({conteo[estado]}).")

    # cobertura_datos: VERIFICADA contra datos_requeridos, no confiada.
    # El plan trae datos_requeridos (copia literal de la ficha); el validador
    # recalcula la cobertura y la compara contra lo que el plan declara.
    cob = plan["cobertura_datos"]
    if not isinstance(cob, dict):
        errores.append("'cobertura_datos' debe ser un objeto.")
    else:
        if "completa" not in cob:
            errores.append("cobertura_datos necesita 'completa' (bool).")
        elif not isinstance(cob["completa"], bool):
            errores.append("cobertura_datos.completa debe ser booleano.")
        for campo in ("datos_sin_fuente", "datos_condicionales"):
            if campo not in cob:
                errores.append(f"cobertura_datos necesita '{campo}' (lista).")
            elif not isinstance(cob[campo], list):
                errores.append(f"cobertura_datos.{campo} debe ser una lista.")

        # Verificación de fondo: recalcular cobertura desde datos_requeridos.
        # Solo si datos_requeridos es una lista válida y las sublistas son listas.
        dr = plan.get("datos_requeridos")
        if not isinstance(dr, list):
            errores.append("'datos_requeridos' debe ser una lista (copia literal de la ficha) para verificar cobertura.")
        elif len(dr) == 0:
            errores.append("'datos_requeridos' no puede estar vacío: sin él no se puede verificar la cobertura.")
        elif (isinstance(cob.get("datos_sin_fuente"), list)
              and isinstance(cob.get("datos_condicionales"), list)):
            requeridos = {d.strip() for d in dr if _texto_no_vacio(d)}
            # Un dato está cubierto-disponible si alguna fuente disponible lo cubre.
            # Está cubierto-solo-condicional si lo cubre una condicional y NINGUNA disponible.
            cubiertos_disp = requeridos & datos_por_disponible
            cubiertos_solo_cond = (requeridos & datos_por_condicional) - datos_por_disponible
            esperado_sin_fuente = requeridos - datos_por_disponible - datos_por_condicional

            declarado_sin_fuente = {d.strip() for d in cob["datos_sin_fuente"] if _texto_no_vacio(d)}
            declarado_condicional = {d.strip() for d in cob["datos_condicionales"] if _texto_no_vacio(d)}

            # 1. datos_sin_fuente declarado debe coincidir con el calculado
            if declarado_sin_fuente != esperado_sin_fuente:
                faltan = esperado_sin_fuente - declarado_sin_fuente
                sobran = declarado_sin_fuente - esperado_sin_fuente
                detalle = []
                if faltan:
                    detalle.append(f"faltan en datos_sin_fuente: {sorted(faltan)}")
                if sobran:
                    detalle.append(f"sobran en datos_sin_fuente (sí tienen fuente): {sorted(sobran)}")
                errores.append("cobertura_datos.datos_sin_fuente no coincide con el cálculo real — " + "; ".join(detalle))

            # 2. datos_condicionales declarado debe coincidir con el calculado
            if declarado_condicional != cubiertos_solo_cond:
                faltan = cubiertos_solo_cond - declarado_condicional
                sobran = declarado_condicional - cubiertos_solo_cond
                detalle = []
                if faltan:
                    detalle.append(f"faltan en datos_condicionales: {sorted(faltan)}")
                if sobran:
                    detalle.append(f"sobran en datos_condicionales: {sorted(sobran)}")
                errores.append("cobertura_datos.datos_condicionales no coincide con el cálculo real — " + "; ".join(detalle))

            # 3. completa debe ser true SII todos los requeridos están cubiertos por disponibles
            completa_real = (cubiertos_disp == requeridos)
            if cob.get("completa") is not None and isinstance(cob.get("completa"), bool):
                if cob["completa"] != completa_real:
                    if completa_real:
                        errores.append("cobertura_datos.completa=false pero todos los datos_requeridos tienen fuente disponible: debería ser true.")
                    else:
                        errores.append("cobertura_datos.completa=true pero no todos los datos_requeridos tienen fuente disponible: debería ser false.")

    return {"valida": len(errores) == 0, "errores": errores, "advertencias": advertencias,
            "requiere_revision_humana": requiere_revision_humana}


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()

    try:
        plan = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"valida": False, "errores": [f"JSON inválido: {e}"],
                          "advertencias": [], "requiere_revision_humana": False}, ensure_ascii=False))
        sys.exit(1)

    resultado = validar(plan)
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
    sys.exit(0 if resultado["valida"] else 1)


if __name__ == "__main__":
    main()
