const GRAPH_BASE = 'https://graph.facebook.com';

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

  // Step 1: resolve download URL
  const metaRes = await fetch(`${GRAPH_BASE}/${apiVersion}/${mediaId}`, { headers: auth });
  if (!metaRes.ok) {
    throw new Error(`Meta media lookup failed for id ${mediaId}: HTTP ${metaRes.status}`);
  }
  const meta = await metaRes.json() as MetaMediaMeta;

  // Step 2: download the raw bytes (still needs the auth header)
  const mediaRes = await fetch(meta.url, { headers: auth });
  if (!mediaRes.ok) {
    throw new Error(`Media download failed: HTTP ${mediaRes.status}`);
  }

  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type };
}
