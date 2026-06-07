"""
Adaptador de extracción para scraping web (metodo_acceso='web').

INVARIANTE: siempre verifica robots.txt antes de hacer fetch.
Si robots.txt bloquea el user-agent, devuelve lista vacía (no lanza excepción).
Solo fetcha la página declarada — sin crawling ni seguimiento de links.

Este adaptador es para casos donde no existe API ni feed pero el contenido
es público y los ToS permiten scraping. La nota_permiso del plan debe
documentar la verificación de ToS antes de usar este método.
"""

from __future__ import annotations

import re
import urllib.request
import urllib.parse
import urllib.robotparser

from .contrato import Registro, ahora_iso

_USER_AGENT = "ForgeExtract/1.0 (+https://nodematik.app)"


def obtener(fuente: dict, credenciales: dict) -> list[Registro]:
    """
    Fetcha la página web declarada en fuente.metadatos.url.
    Verifica robots.txt antes del fetch. Si bloqueado → lista vacía.
    Extrae texto limpio (sin HTML).
    """
    fuente_id = fuente.get("id", "web")
    metadatos = fuente.get("metadatos") or {}
    url = metadatos.get("url", "")

    if not url:
        raise ValueError(f"fuente '{fuente_id}' tipo 'web' requiere metadatos.url.")

    # Verificar robots.txt — si bloqueado, no fetchar
    if not _robots_permite(url):
        return []

    html = _fetch_html(url)
    texto = _html_a_texto(html)

    if not texto.strip():
        return []

    ts = ahora_iso()
    datos_cubiertos = fuente.get("datos_que_cubre", [])

    return [
        Registro(
            contenido=texto[:10_000],  # recortar para evitar registros gigantes
            fuente=fuente_id,
            metodo_acceso="web",
            datos_cubiertos=list(datos_cubiertos),
            metadatos={"url": url},
            obtenido_en=ts,
        )
    ]


def _robots_permite(url: str) -> bool:
    """Verifica que el user-agent está permitido por robots.txt."""
    try:
        parsed = urllib.parse.urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        return rp.can_fetch(_USER_AGENT, url)
    except Exception:
        # Si no se puede leer robots.txt, ser conservador: no fetchar
        return False


def _fetch_html(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        encoding = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(encoding, errors="replace")


def _html_a_texto(html: str) -> str:
    """Extrae texto plano del HTML removiendo tags."""
    # Remover scripts y styles completos
    texto = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    texto = re.sub(r"<style[^>]*>.*?</style>", " ", texto, flags=re.DOTALL | re.IGNORECASE)
    # Remover todos los tags HTML
    texto = re.sub(r"<[^>]+>", " ", texto)
    # Normalizar espacios
    texto = re.sub(r"\s+", " ", texto)
    # Decodificar entidades HTML básicas
    texto = texto.replace("&amp;", "&")
    texto = texto.replace("&lt;", "<")
    texto = texto.replace("&gt;", ">")
    texto = texto.replace("&quot;", '"')
    texto = texto.replace("&#39;", "'")
    texto = texto.replace("&nbsp;", " ")
    return texto.strip()
