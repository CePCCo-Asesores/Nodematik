const GRAPH_BASE = 'https://graph.facebook.com';

const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB — Meta's own limit

const ALLOWED_MIME_TYPES = new Set([
  'audio/ogg', 'audio/ogg; codecs=opus',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/3gpp',
]);

const DOWNLOAD_TIMEOUT_MS = 30_000;

interface MetaMediaMeta {
  url: string;
  mime_type: string;
  sha256?: string;
  file_size?: number;
  id: string;
}

// Downloads a WhatsApp media file via the Meta Cloud API.
// Two-step: resolve the media URL, then download the bytes.
export async function downloadMedia(
  mediaId: string,
  accessToken: string,
  apiVersion: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    // Step 1: resolve download URL
    const metaRes = await fetch(`${GRAPH_BASE}/${apiVersion}/${mediaId}`, {
      headers: auth,
      signal: controller.signal,
    });
    if (!metaRes.ok) {
      throw new Error(`Meta media lookup failed for id ${mediaId}: HTTP ${metaRes.status}`);
    }
    const meta = await metaRes.json() as MetaMediaMeta;

    // Validate MIME type before downloading
    const baseMime = meta.mime_type.split(';')[0].trim();
    if (!ALLOWED_MIME_TYPES.has(meta.mime_type) && !ALLOWED_MIME_TYPES.has(baseMime)) {
      throw new Error(`Unsupported media type: ${meta.mime_type}`);
    }

    // Reject oversized files early if Meta reports the size
    if (meta.file_size && meta.file_size > MAX_MEDIA_SIZE_BYTES) {
      throw new Error(`Media file too large: ${meta.file_size} bytes (limit ${MAX_MEDIA_SIZE_BYTES})`);
    }

    // Step 2: download the raw bytes (still needs the auth header)
    const mediaRes = await fetch(meta.url, {
      headers: auth,
      signal: controller.signal,
    });
    if (!mediaRes.ok) {
      throw new Error(`Media download failed: HTTP ${mediaRes.status}`);
    }

    // Check Content-Length before buffering
    const contentLength = Number(mediaRes.headers.get('content-length') ?? 0);
    if (contentLength > MAX_MEDIA_SIZE_BYTES) {
      throw new Error(`Media file too large: ${contentLength} bytes (limit ${MAX_MEDIA_SIZE_BYTES})`);
    }

    const buffer = Buffer.from(await mediaRes.arrayBuffer());

    // Final post-download size check (Content-Length may be absent or spoofed)
    if (buffer.length > MAX_MEDIA_SIZE_BYTES) {
      throw new Error(`Media file too large: ${buffer.length} bytes (limit ${MAX_MEDIA_SIZE_BYTES})`);
    }

    return { buffer, mimeType: meta.mime_type };
  } finally {
    clearTimeout(timeoutId);
  }
}
