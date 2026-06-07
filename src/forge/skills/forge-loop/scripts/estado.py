"""
Tipos y contratos para el estado del lazo continuo forge-loop.

El EstadoLazo es el estado en reposo del operador vivo.
El scheduler lo despierta en ráfagas; entre ejecuciones no hay proceso activo.

AlmacenEstado define la interfaz que el backend implementa sobre Postgres.
REQUISITO CRÍTICO: todo acceso de escritura al estado de un lazo activo
debe usar SELECT … FOR UPDATE SKIP LOCKED para evitar ráfagas concurrentes.

AlmacenMemoria es una implementación en memoria para tests y diseño.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Protocol, runtime_checkable


# ───────────────────────────────────────────────
# Tipos auxiliares
# ───────────────────────────────────────────────

@dataclass
class Ritmo:
    """
    Define la cadencia de ejecución del lazo.

    tipo='cron': el lazo corre según una expresión cron (ej: "0 9 * * 1" = lunes 9h).
    tipo='umbral': el lazo corre cuando la métrica cruza el valor (ej: "precio > 1000").
    """
    tipo: str              # 'cron' | 'umbral'
    valor: str = ""        # expresión cron (si tipo='cron')
    metrica: str = ""      # nombre de la métrica a monitorear (si tipo='umbral')
    operador: str = ""     # '>' | '<' | '>=' | '<=' | '==' (si tipo='umbral')
    valor_umbral: float = 0.0  # valor numérico del umbral (si tipo='umbral')

    def __post_init__(self) -> None:
        if self.tipo not in ("cron", "umbral"):
            raise ValueError(f"Ritmo.tipo debe ser 'cron' o 'umbral', got: '{self.tipo}'")
        if self.tipo == "cron" and not self.valor.strip():
            raise ValueError("Ritmo cron requiere 'valor' (expresión cron).")
        if self.tipo == "umbral" and not self.metrica.strip():
            raise ValueError("Ritmo umbral requiere 'metrica'.")


@dataclass
class SkillOperante:
    """El skill que está resolviendo activamente el problema del lazo."""
    name: str              # kebab-case
    version: int
    approved_at: str       # ISO 8601 — cuando fue aprobado


@dataclass
class PoliticaAdaptacion:
    """
    Controla cuándo y cuántas veces el lazo puede adaptar su skill_operante.

    adaptar_si: condición textual que describe cuándo iniciar adaptación.
    no_adaptar_si: condición textual que frena la adaptación.
    max_adaptaciones_por_periodo: techo anti-hiperactividad.
    periodo_horas: ventana del techo en horas.
    extraccion_vacia_es_fallo: si False, extracción vacía no cuenta como fallo
      (útil para monitoreo de ausencia — "avisar cuando NO haya eventos").
    """
    adaptar_si: str
    no_adaptar_si: str
    max_adaptaciones_por_periodo: int = 3
    periodo_horas: int = 24
    extraccion_vacia_es_fallo: bool = True


@dataclass
class Huella:
    """Snapshot del resultado de la última ejecución exitosa."""
    contenido_hash: str    # hash del contenido concatenado de los registros
    cobertura_pct: float   # cobertura de datos_requeridos en esa ejecución
    fuentes_activas: list[str]  # ids de fuentes que aportaron registros


@dataclass
class EntradaHistorial:
    """Una entrada en el historial de eventos del lazo."""
    ts: str                # ISO 8601
    evento: str            # 'ejecucion_ok' | 'fallo' | 'adaptacion_iniciada' | 'pausa' | etc.
    detalle: str = ""


# ───────────────────────────────────────────────
# Estado principal
# ───────────────────────────────────────────────

@dataclass
class EstadoLazo:
    """
    Estado completo y persistente de un lazo continuo.

    Este objeto se serializa/deserializa desde Postgres (modelo LoopState).
    Los campos Json del modelo corresponden a los tipos anidados aquí.
    """
    loop_id: str
    ficha_id: str
    org_id: str
    ritmo: Ritmo
    skill_operante: SkillOperante
    politica_adaptacion: PoliticaAdaptacion

    estado_operativo: str = "activo"   # 'activo'|'pausado'|'adaptando'|'detenido'
    ultima_ejecucion: Optional[datetime] = None
    proxima_ejecucion: Optional[datetime] = None
    ejecuciones_totales: int = 0
    huella_anterior: Optional[Huella] = None
    fallos_consecutivos: int = 0
    ultima_anomalia: Optional[dict] = None
    pendiente_aprobacion: bool = False
    cooldown_adaptacion_hasta: Optional[datetime] = None
    adaptaciones_en_periodo: dict = field(default_factory=lambda: {"periodo_inicio": "", "count": 0})
    historial: list[EntradaHistorial] = field(default_factory=list)

    def __post_init__(self) -> None:
        estados_validos = {"activo", "pausado", "adaptando", "detenido"}
        if self.estado_operativo not in estados_validos:
            raise ValueError(
                f"estado_operativo '{self.estado_operativo}' inválido. "
                f"Válidos: {sorted(estados_validos)}."
            )


# ───────────────────────────────────────────────
# Interfaz del almacén (para el backend)
# ───────────────────────────────────────────────

@runtime_checkable
class AlmacenEstado(Protocol):
    """
    Interfaz que el backend TypeScript implementa sobre Postgres.

    REQUISITO DE CONCURRENCIA:
    cargar_con_lock() debe implementarse con:
      SELECT * FROM loop_states WHERE loop_id = $1 FOR UPDATE SKIP LOCKED

    Si el registro está bloqueado por otra instancia, devolver None.
    Esto garantiza que solo una ráfaga procese el mismo lazo a la vez.
    Sin el lock, dos instancias del scheduler podrían ejecutar el mismo
    lazo simultáneamente, corrompiendo el estado.
    """

    def cargar_con_lock(self, loop_id: str) -> Optional[EstadoLazo]:
        """
        Carga el estado del lazo con lock exclusivo.
        Devuelve None si el registro está bloqueado o no existe.
        La transacción debe permanecer abierta hasta guardar_y_liberar().
        """
        ...

    def guardar_y_liberar(self, estado: EstadoLazo) -> None:
        """
        Persiste el estado actualizado y libera el lock.
        Debe llamarse siempre que cargar_con_lock() devolvió un estado.
        """
        ...

    def listar_pendientes(self) -> list[str]:
        """
        Lista los loop_ids de lazos activos cuya proxima_ejecucion ya pasó.
        Consulta: WHERE estado_operativo='activo' AND proxima_ejecucion <= NOW()
        Usa el índice (estado_operativo, proxima_ejecucion).
        """
        ...


# ───────────────────────────────────────────────
# Implementación en memoria (solo para tests)
# ───────────────────────────────────────────────

class AlmacenMemoria:
    """
    Implementación en memoria del AlmacenEstado para tests y diseño.
    No simula concurrencia — sirve para tests unitarios del motor.
    """

    def __init__(self) -> None:
        self._estados: dict[str, EstadoLazo] = {}
        self._bloqueados: set[str] = set()

    def agregar(self, estado: EstadoLazo) -> None:
        self._estados[estado.loop_id] = estado

    def cargar_con_lock(self, loop_id: str) -> Optional[EstadoLazo]:
        if loop_id in self._bloqueados:
            return None
        estado = self._estados.get(loop_id)
        if estado is not None:
            self._bloqueados.add(loop_id)
        return estado

    def guardar_y_liberar(self, estado: EstadoLazo) -> None:
        self._estados[estado.loop_id] = estado
        self._bloqueados.discard(estado.loop_id)

    def listar_pendientes(self) -> list[str]:
        ahora = datetime.now(timezone.utc)
        return [
            e.loop_id
            for e in self._estados.values()
            if e.estado_operativo == "activo"
            and e.proxima_ejecucion is not None
            and e.proxima_ejecucion <= ahora
        ]
