"""
Adaptadores de extracción de forge-extract.

Cada módulo implementa el contrato Adaptador para un metodo_acceso. El orquestador
los registra por su atributo .metodo. Agregar una fuente nueva al sistema es agregar
un módulo aquí que cumpla el contrato — el orquestador no cambia.

Adaptadores actuales:
  adaptador_feed     -> feed   (RSS/Atom) — funcional
  adaptador_api      -> api    (REST/JSON) — funcional para APIs REST simples
  adaptador_web      -> web    (HTML público) — funcional, respeta el principio de permiso
  adaptador_archivo  -> archivo_cliente (archivos que el cliente aporta) — funcional
  adaptador_dataset  -> dataset_abierto (CSV/JSON abiertos) — funcional
"""
