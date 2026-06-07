#!/usr/bin/env python3
"""
Validador determinista del estado de un lazo de operación continua.

El estado es lo que persiste entre ráfagas y lo que cualquier worker lee para reanimar
el lazo. Debe estar bien formado y ser coherente, o un worker podría reanimar un lazo
en un estado imposible. Verifica estructura y coherencia de los estados operativos.

Uso: python validar_estado.py estado.json
Salida: JSON {"valida": bool, "errores": [str], "advertencias": [str]}
"""

import json
import sys

ESTADOS_OPERATIVOS = {"activo", "pausado", "adaptando", "detenido"}
CAMPOS = {"loop_id", "ficha_id", "org_id", "estado_operativo"}  # ritmo se valida aparte (es objeto)


def _txt(v):
    return isinstance(v, str) and bool(v.strip())


def validar(e):
    errores, advertencias = [], []
    if not isinstance(e, dict):
        return {"valida": False, "errores": ["El estado debe ser un objeto JSON."], "advertencias": []}

    for c in CAMPOS:
        if not _txt(e.get(c)):
            errores.append(f"Falta o está vacío el campo requerido '{c}'.")

    estado_op = e.get("estado_operativo")
    if estado_op and estado_op not in ESTADOS_OPERATIVOS:
        errores.append(f"estado_operativo debe ser uno de {sorted(ESTADOS_OPERATIVOS)}, no '{estado_op}'.")

    ritmo = e.get("ritmo")
    ritmo_temporal = False
    if ritmo is None:
        errores.append("Falta el campo requerido 'ritmo'.")
    elif not isinstance(ritmo, dict):
        errores.append("'ritmo' debe ser un objeto {tipo, ...}.")
    else:
        tipo = ritmo.get("tipo")
        if tipo == "cron":
            ritmo_temporal = True
            if ritmo.get("valor") not in {"cada_hora", "diario", "semanal"}:
                errores.append(f"ritmo cron.valor debe ser cada_hora|diario|semanal, no '{ritmo.get('valor')}'.")
        elif tipo == "umbral":
            if not _txt(ritmo.get("metrica")):
                errores.append("ritmo umbral necesita 'metrica'.")
            if ritmo.get("operador") not in {">", "<", ">=", "<=", "=="}:
                errores.append(f"ritmo umbral.operador inválido: '{ritmo.get('operador')}'.")
            if not isinstance(ritmo.get("valor"), (int, float)):
                errores.append("ritmo umbral.valor debe ser numérico.")
        else:
            errores.append(f"ritmo.tipo debe ser 'cron' o 'umbral', no '{tipo}'.")

    # Coherencia de contadores
    for num in ("ejecuciones_totales", "fallos_consecutivos"):
        v = e.get(num, 0)
        if not isinstance(v, int) or v < 0:
            errores.append(f"'{num}' debe ser un entero >= 0.")

    # Coherencia de estados: 'adaptando' implica que hay algo pendiente de aprobación.
    if estado_op == "adaptando" and not e.get("pendiente_aprobacion"):
        errores.append("estado 'adaptando' exige pendiente_aprobacion=true: una adaptación cruza el gate.")

    # Un lazo con ritmo temporal y activo debería tener proxima_ejecucion.
    if estado_op == "activo" and ritmo_temporal:
        if not _txt(e.get("proxima_ejecucion")):
            advertencias.append("lazo activo con ritmo temporal sin proxima_ejecucion: no despertará. ¿Falta agendar?")

    # 'detenido' es terminal: no debería tener proxima_ejecucion.
    if estado_op == "detenido" and _txt(e.get("proxima_ejecucion")):
        advertencias.append("lazo 'detenido' con proxima_ejecucion: no se reanimará, conviene limpiarla.")

    # skill_operante: si está presente, debe ser objeto con name y version (la versión
    # importa en lazos vivos: hay que saber qué capacidad exacta opera).
    so = e.get("skill_operante")
    if so is not None:
        if not isinstance(so, dict):
            errores.append("'skill_operante' debe ser un objeto {name, version, approved_at} (no un string).")
        else:
            if not _txt(so.get("name")):
                errores.append("skill_operante necesita 'name'.")
            if not _txt(so.get("version")):
                errores.append("skill_operante necesita 'version': en un lazo vivo hay que saber qué versión opera.")

    # Timestamps: detectar basura (no validación perfecta, solo que parseen como ISO).
    from datetime import datetime
    def _es_iso(s):
        try:
            datetime.fromisoformat(s); return True
        except (ValueError, TypeError):
            return False
    for campo in ("ultima_ejecucion", "proxima_ejecucion", "cooldown_adaptacion_hasta"):
        v = e.get(campo)
        if v is not None and not _es_iso(v):
            errores.append(f"'{campo}' no es un timestamp ISO válido: {v!r}.")
    adapts = e.get("adaptaciones_en_periodo", [])
    if isinstance(adapts, list):
        for i, ts in enumerate(adapts):
            if not _es_iso(ts):
                errores.append(f"adaptaciones_en_periodo[{i}] no es un timestamp ISO válido: {ts!r}.")

    # pendiente_aprobacion=true es incoherente con un lazo 'activo' operando normal:
    # debería estar 'adaptando' (esperando esa aprobación) o 'pausado'.
    if e.get("pendiente_aprobacion") and estado_op == "activo":
        advertencias.append("pendiente_aprobacion=true con estado 'activo': si hay algo esperando el gate, "
                            "el lazo debería estar 'adaptando' o 'pausado', no operando normal.")

    # Un lazo pausado sin rastro de por qué deja al humano sin contexto para actuar.
    if estado_op == "pausado":
        tiene_anomalia = bool(e.get("ultima_anomalia"))
        tiene_evento_pausa = any("paus" in str(ev.get("accion", "")).lower() for ev in (e.get("historial") or []))
        if not (tiene_anomalia or tiene_evento_pausa):
            advertencias.append("lazo 'pausado' sin ultima_anomalia ni evento de pausa en el historial: "
                               "falta el motivo para que un humano sepa qué atender.")

    # Historial acotado
    hist = e.get("historial", [])
    if not isinstance(hist, list):
        errores.append("'historial' debe ser una lista.")
    elif len(hist) > 50:
        advertencias.append(f"historial con {len(hist)} entradas excede el máximo de 50; debería acotarse.")

    # Política de adaptación: coherencia de los frenos contra loops hiperactivos.
    pol = e.get("politica_adaptacion")
    if pol is not None:
        if not isinstance(pol, dict):
            errores.append("'politica_adaptacion' debe ser un objeto.")
        else:
            maxad = pol.get("max_adaptaciones_por_periodo")
            if not isinstance(maxad, int) or maxad < 1:
                errores.append("politica_adaptacion.max_adaptaciones_por_periodo debe ser un entero >= 1.")
            per = pol.get("periodo_horas")
            if not isinstance(per, (int, float)) or per <= 0:
                errores.append("politica_adaptacion.periodo_horas debe ser un número > 0.")
            for k in ("adaptar_si", "no_adaptar_si"):
                if k in pol and not isinstance(pol[k], list):
                    errores.append(f"politica_adaptacion.{k} debe ser una lista.")

    # adaptaciones_en_periodo coherente
    adapts = e.get("adaptaciones_en_periodo", [])
    if not isinstance(adapts, list):
        errores.append("'adaptaciones_en_periodo' debe ser una lista de timestamps.")

    return {"valida": len(errores) == 0, "errores": errores, "advertencias": advertencias}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"valida": False, "errores": ["Uso: python validar_estado.py estado.json"],
                          "advertencias": []}, ensure_ascii=False))
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        e = json.load(fh)
    r = validar(e)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    sys.exit(0 if r["valida"] else 1)


if __name__ == "__main__":
    main()
