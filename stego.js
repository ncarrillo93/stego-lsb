// Protocolo binario Stego LSB: STG1 (legacy, 8 B) y STG2 completo (CRC-32, 8 planos progresivos,
// compresión deflate-raw, cifrado AES-256-GCM + PBKDF2/HKDF y dispersión Feistel O(1)).
export const MAGIC_V1 = [0x53, 0x54, 0x47, 0x31]; // "STG1"
export const HEADER_BYTES_V1 = 8;

export const MAGIC_V2 = [0x53, 0x54, 0x47, 0x32]; // "STG2"
export const HEADER_BYTES_V2 = 13;
export const HEADER_BYTES_V2_ENCRYPTED = 39;
export const GCM_TAG_BYTES = 16;

// Exports de compatibilidad apuntando al formato actual (STG2).
export const MAGIC = MAGIC_V2;
export const HEADER_BYTES = HEADER_BYTES_V2;

export const FLAGS = Object.freeze({
  ENCRYPTED: 0x01,
  COMPRESSED: 0x02,
  FILE: 0x04,
  SCATTERED: 0x08,
  MULTIBIT: 0x10
});

export const WARN_PIXELS = 8_000_000;
export const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MiB (defensa anti-zip-bomb)
export const DEFAULT_KDF_ITERATIONS = 600_000;

const MIN_KDF_FACTOR = 10; // 100_000 iteraciones
const MAX_KDF_FACTOR = 255; // 2_550_000 iteraciones (límite uint8 en byte 9)
const HEADER_OPAQUE_PIXELS_ENCRYPTED = (HEADER_BYTES_V2_ENCRYPTED * 8) / 3; // 104 píxeles exactos
const KNOWN_FLAGS_MASK =
  FLAGS.ENCRYPTED | FLAGS.COMPRESSED | FLAGS.FILE | FLAGS.SCATTERED | FLAGS.MULTIBIT;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

let cachedCompressionSupport = null;

// Tabla IEEE 802.3 (polinomio reflejado 0xEDB88320) para CRC-32.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function createCodedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

export function utf8ByteLength(text) {
  return encoder.encode(text || '').length;
}

export function crc32(bytes) {
  const view = toUint8Array(bytes);
  let crc = 0xffffffff;
  for (let i = 0; i < view.length; i++) {
    crc = CRC32_TABLE[(crc ^ view[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function isCryptoSupported() {
  return (
    typeof globalThis.crypto !== 'undefined' &&
    Boolean(globalThis.crypto.subtle) &&
    typeof globalThis.crypto.subtle.encrypt === 'function' &&
    typeof globalThis.crypto.subtle.deriveBits === 'function' &&
    (typeof globalThis.isSecureContext === 'undefined' || globalThis.isSecureContext)
  );
}

export function isCompressionSupported() {
  if (cachedCompressionSupport !== null) {
    return cachedCompressionSupport;
  }
  try {
    new CompressionStream('deflate-raw');
    new DecompressionStream('deflate-raw');
    cachedCompressionSupport = true;
  } catch {
    cachedCompressionSupport = false;
  }
  return cachedCompressionSupport;
}

export function getHeaderBytes({ encrypted = false } = {}) {
  return encrypted ? HEADER_BYTES_V2_ENCRYPTED : HEADER_BYTES_V2;
}

export function getOverheadBytes({ encrypted = false } = {}) {
  return encrypted ? HEADER_BYTES_V2_ENCRYPTED + GCM_TAG_BYTES : HEADER_BYTES_V2;
}

export function getCapacityBytes(stats, { encrypted = false, scattered = false } = {}) {
  const overheadBytes = getOverheadBytes({ encrypted });
  if (!stats || stats.opaquePixels <= 0) {
    return { losslessBytes: 0, maxTotalBytes: 0, overheadBytes };
  }

  const headerBytes = getHeaderBytes({ encrypted });
  if (stats.losslessBits < headerBytes * 8) {
    return { losslessBytes: 0, maxTotalBytes: 0, overheadBytes };
  }

  if (encrypted && scattered) {
    const remainingOpaque = stats.opaquePixels - HEADER_OPAQUE_PIXELS_ENCRYPTED;
    if (remainingOpaque <= 0) {
      return { losslessBytes: 0, maxTotalBytes: 0, overheadBytes };
    }
    const losslessBytes = Math.max(0, Math.floor((remainingOpaque * 3) / 8) - GCM_TAG_BYTES);
    const maxTotalBytes = Math.max(0, remainingOpaque * 3 - GCM_TAG_BYTES);
    return { losslessBytes, maxTotalBytes, overheadBytes };
  }

  const losslessBytes = Math.max(0, Math.floor(stats.losslessBits / 8) - overheadBytes);
  const maxTotalBytes = Math.max(0, Math.floor(stats.maxTotalBits / 8) - overheadBytes);
  return { losslessBytes, maxTotalBytes, overheadBytes };
}

export function analyzeImageData(imageData) {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  let opaquePixels = 0;

  // Solo usamos píxeles con A=255 porque Canvas premultiplica alfa y redondea RGB si A<255.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255) {
      opaquePixels++;
    }
  }

  const losslessBits = opaquePixels * 3;
  const maxTotalBits = losslessBits * 8;
  const hasHeaderSpace = losslessBits >= HEADER_BYTES_V2 * 8;
  const losslessBytes = hasHeaderSpace
    ? Math.max(0, Math.floor(losslessBits / 8) - HEADER_BYTES_V2)
    : 0;
  const maxTotalBytes = hasHeaderSpace
    ? Math.max(0, Math.floor(maxTotalBits / 8) - HEADER_BYTES_V2)
    : 0;

  return {
    width,
    height,
    totalPixels,
    opaquePixels,
    losslessBits,
    losslessBytes,
    maxTotalBits,
    maxTotalBytes,
    usableBits: losslessBits,
    maxMessageBytes: losslessBytes
  };
}

export function estimateQuality(usedBits, opaquePixels) {
  const bitsPerPlane = Math.max(0, (opaquePixels || 0) * 3);
  const maxTotalBits = bitsPerPlane * 8;

  if (!usedBits || usedBits <= 0 || bitsPerPlane === 0) {
    return {
      planesUsed: 0,
      activePlaneFill: 0,
      overallPercent: 0,
      losslessPercent: 0,
      level: 'empty',
      label: 'Sin datos',
      badgeClass: 'text-bg-secondary',
      maxChannelDelta: 0
    };
  }

  const planesUsed = Math.min(8, Math.ceil(usedBits / bitsPerPlane));
  const bitsInActivePlane =
    usedBits >= maxTotalBits ? bitsPerPlane : ((usedBits - 1) % bitsPerPlane) + 1;
  const activePlaneFill = (bitsInActivePlane / bitsPerPlane) * 100;
  const overallPercent = (usedBits / maxTotalBits) * 100;
  const losslessPercent = (usedBits / bitsPerPlane) * 100;
  const maxChannelDelta = (1 << planesUsed) - 1;

  let level;
  let label;
  let badgeClass;

  if (planesUsed === 1) {
    level = 'lossless';
    label = 'Imperceptible (1 plano)';
    badgeClass = 'text-bg-success';
  } else if (planesUsed === 2) {
    level = 'high';
    label = 'Alta calidad (2 planos)';
    badgeClass = 'text-bg-info';
  } else if (planesUsed <= 4) {
    level = 'visible';
    label = `Degradación visible (${planesUsed} planos)`;
    badgeClass = 'text-bg-warning';
  } else if (planesUsed <= 6) {
    level = 'heavy';
    label = `Degradación fuerte (${planesUsed} planos)`;
    badgeClass = 'text-bg-danger';
  } else {
    level = 'destroyed';
    label = `Imagen destruida (${planesUsed} planos)`;
    badgeClass = 'text-bg-dark border border-danger';
  }

  return {
    planesUsed,
    activePlaneFill,
    overallPercent,
    losslessPercent,
    level,
    label,
    badgeClass,
    maxChannelDelta
  };
}

function estimateScatteredQuality(bodyBits, opaquePixels) {
  const remainingOpaque = Math.max(0, opaquePixels - HEADER_OPAQUE_PIXELS_ENCRYPTED);
  const bodyBitsPerPlane = remainingOpaque * 3;
  const totalBits = HEADER_BYTES_V2_ENCRYPTED * 8 + bodyBits;
  const base = estimateQuality(totalBits, opaquePixels);

  if (bodyBitsPerPlane <= 0 || bodyBits <= bodyBitsPerPlane) {
    return base;
  }

  const actualPlanes = Math.min(8, Math.ceil(bodyBits / bodyBitsPerPlane));
  const bitsInActive =
    bodyBits >= bodyBitsPerPlane * 8 ? bodyBitsPerPlane : ((bodyBits - 1) % bodyBitsPerPlane) + 1;
  const adjusted = estimateQuality((actualPlanes - 1) * (opaquePixels * 3) + 1, opaquePixels);

  return {
    ...adjusted,
    activePlaneFill: (bitsInActive / bodyBitsPerPlane) * 100,
    overallPercent: base.overallPercent,
    losslessPercent: base.losslessPercent
  };
}

export function computePsnr(origData, encData) {
  const a = origData?.data || origData;
  const b = encData?.data || encData;

  if (!a || !b || a.length !== b.length) {
    throw new Error('Los buffers de imagen deben tener la misma longitud para calcular PSNR.');
  }

  let sse = 0;
  let channelCount = 0;

  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] !== 255) continue;
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    sse += dr * dr + dg * dg + db * db;
    channelCount += 3;
  }

  if (channelCount === 0 || sse === 0) {
    return Infinity;
  }

  const mse = sse / channelCount;
  return 10 * Math.log10((255 * 255) / mse);
}

function createSingleChunkStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    }
  });
}

async function readStreamBytes(readable, maxBytes) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel('Decompression limit exceeded');
        } catch {
          // Ignorar error de cancelación del stream subyacente.
        }
        throw createCodedError(
          'DECOMPRESSION_LIMIT',
          `Los datos descomprimidos superan el límite de seguridad (${maxBytes} bytes).`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function compressRaw(bytes) {
  if (!isCompressionSupported()) {
    throw createCodedError(
      'COMPRESSION_UNSUPPORTED',
      'Tu navegador no soporta compresión deflate-raw (CompressionStream).'
    );
  }
  const input = toUint8Array(bytes);
  const stream = createSingleChunkStream(input).pipeThrough(new CompressionStream('deflate-raw'));
  return readStreamBytes(stream, Infinity);
}

export async function decompressRaw(bytes, maxBytes = MAX_DECOMPRESSED_BYTES) {
  if (!isCompressionSupported()) {
    throw createCodedError(
      'COMPRESSION_UNSUPPORTED',
      'Tu navegador no soporta descompresión deflate-raw (DecompressionStream).'
    );
  }
  const input = toUint8Array(bytes);
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : MAX_DECOMPRESSED_BYTES;
  const stream = createSingleChunkStream(input).pipeThrough(new DecompressionStream('deflate-raw'));

  try {
    return await readStreamBytes(stream, limit);
  } catch (err) {
    if (err && err.code === 'DECOMPRESSION_LIMIT') {
      throw err;
    }
    throw new Error('No se pudieron descomprimir los datos deflate-raw (flujo dañado).');
  }
}

export async function deriveKeys(password, salt, iterations = DEFAULT_KDF_ITERATIONS) {
  if (!isCryptoSupported()) {
    throw createCodedError(
      'CRYPTO_UNSUPPORTED',
      'Tu navegador no habilita Web Crypto API (crypto.subtle) en este contexto. Ábrelo desde HTTPS (GitHub Pages) o localhost.'
    );
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw createCodedError('PASSWORD_REQUIRED', 'Ingresa una contraseña válida.');
  }

  const saltBytes = toUint8Array(salt);
  if (saltBytes.byteLength !== 16) {
    throw new Error('El salt criptográfico debe tener exactamente 16 bytes.');
  }

  const subtle = globalThis.crypto.subtle;
  const baseKey = await subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Un solo bloque PBKDF2-SHA256 (256 bits) evita duplicar el costo de KDF; HKDF expande las subclaves.
  const masterBits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    256
  );

  const hkdfKey = await subtle.importKey('raw', masterBits, 'HKDF', false, [
    'deriveKey',
    'deriveBits'
  ]);
  const emptySalt = new Uint8Array(0);

  const aesKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: emptySalt,
      info: encoder.encode('stego-lsb-v2-aes')
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const feistelBuf = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: emptySalt,
      info: encoder.encode('stego-lsb-v2-feistel')
    },
    hkdfKey,
    24 * 8
  );

  const feistelView = new DataView(feistelBuf);
  const feistelKeys = new Uint32Array(6);
  for (let r = 0; r < 6; r++) {
    feistelKeys[r] = feistelView.getUint32(r * 4, false);
  }

  return { aesKey, feistelKeys };
}

// Red de Feistel balanceada de 6 rondas sobre dominio 4^halfBits con cycle walking (biyección exacta).
function createFeistelPermuter(domainSize, roundKeys) {
  if (domainSize <= 1) {
    return (x) => x;
  }

  const halfBits = Math.max(1, Math.ceil(Math.log2(domainSize) / 2));
  const mask = (1 << halfBits) - 1;

  function feistelBlock(x) {
    let left = (x >>> halfBits) & mask;
    let right = x & mask;
    for (let r = 0; r < 6; r++) {
      let h = Math.imul((right ^ roundKeys[r]) >>> 0, 0x9e3779b1) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
      h = (h ^ (h >>> 13)) & mask;
      const nextRight = left ^ h;
      left = right;
      right = nextRight;
    }
    return ((left << halfBits) | right) >>> 0;
  }

  return function permute(index) {
    let y = feistelBlock(index >>> 0);
    while (y >= domainSize) {
      y = feistelBlock(y);
    }
    return y;
  };
}

// Direccionamiento O(1) RAM en fotos opacas; tabla compacta solo si existen píxeles con A < 255.
function createBodyPixelLocator(data, stats, headerOpaquePixels) {
  const count = Math.max(0, stats.opaquePixels - headerOpaquePixels);
  if (stats.opaquePixels === stats.totalPixels) {
    return {
      count,
      byteOffsetAt(k) {
        return (headerOpaquePixels + k) * 4;
      }
    };
  }

  const offsets = new Uint32Array(count);
  let seenOpaque = 0;
  let idx = 0;
  for (let i = 0; i < data.length && idx < count; i += 4) {
    if (data[i + 3] === 255) {
      if (seenOpaque >= headerOpaquePixels) {
        offsets[idx++] = i;
      }
      seenOpaque++;
    }
  }

  return {
    count,
    byteOffsetAt(k) {
      return offsets[k];
    }
  };
}

// Fuente de bits aleatorios en bloques de 4 KB para LSB Matching (±1) en plano 0.
function createRandomBitSource() {
  const buf = new Uint8Array(4096);
  let byteIndex = buf.length;
  let bitMask = 0;
  let currentByte = 0;

  return function nextRandomBit() {
    if (bitMask === 0) {
      if (byteIndex >= buf.length) {
        if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
          globalThis.crypto.getRandomValues(buf);
        } else {
          for (let i = 0; i < buf.length; i++) {
            buf[i] = (Math.random() * 256) | 0;
          }
        }
        byteIndex = 0;
      }
      currentByte = buf[byteIndex++];
      bitMask = 0x80;
    }

    const bit = (currentByte & bitMask) !== 0 ? 1 : 0;
    bitMask >>>= 1;
    return bit;
  };
}

function applyLsbMatch(out, idx, bit, nextRandBit) {
  const val = out[idx];
  if ((val & 1) !== bit) {
    if (val === 0) {
      out[idx] = 1;
    } else if (val === 255) {
      out[idx] = 254;
    } else {
      out[idx] = val + (nextRandBit() ? 1 : -1);
    }
  }
}

function embedSequentialBytes(out, payload, nextRandBit) {
  const totalBits = payload.length * 8;
  let bitPos = 0;

  for (let plane = 0; plane < 8 && bitPos < totalBits; plane++) {
    if (plane === 0) {
      for (let i = 0; i < out.length && bitPos < totalBits; i += 4) {
        if (out[i + 3] !== 255) continue;
        for (let c = 0; c < 3 && bitPos < totalBits; c++) {
          const bit = (payload[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
          applyLsbMatch(out, i + c, bit, nextRandBit);
          bitPos++;
        }
      }
    } else {
      const clearMask = ~(1 << plane) & 0xff;
      for (let i = 0; i < out.length && bitPos < totalBits; i += 4) {
        if (out[i + 3] !== 255) continue;
        for (let c = 0; c < 3 && bitPos < totalBits; c++) {
          const bit = (payload[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
          out[i + c] = (out[i + c] & clearMask) | (bit << plane);
          bitPos++;
        }
      }
    }
  }
}

function embedScatteredEncrypted(out, headerRaw, bodyBytes, stats, feistelKeys, nextRandBit) {
  // 1. Cabecera de 39 B secuencial en los primeros 104 píxeles opacos del plano 0.
  embedSequentialBytes(out, headerRaw, nextRandBit);

  // 2. Cuerpo disperso con permutación Feistel sobre los M = opaquePixels - 104 píxeles restantes.
  const locator = createBodyPixelLocator(out, stats, HEADER_OPAQUE_PIXELS_ENCRYPTED);
  const permute = createFeistelPermuter(locator.count, feistelKeys);
  const bodyBits = bodyBytes.length * 8;
  let bodyBitPos = 0;

  for (let plane = 0; plane < 8 && bodyBitPos < bodyBits; plane++) {
    const clearMask = ~(1 << plane) & 0xff;
    for (let k = 0; k < locator.count && bodyBitPos < bodyBits; k++) {
      const pixelOffset = locator.byteOffsetAt(permute(k));
      for (let c = 0; c < 3 && bodyBitPos < bodyBits; c++) {
        const bit = (bodyBytes[bodyBitPos >>> 3] >>> (7 - (bodyBitPos & 7))) & 1;
        if (plane === 0) {
          applyLsbMatch(out, pixelOffset + c, bit, nextRandBit);
        } else {
          out[pixelOffset + c] = (out[pixelOffset + c] & clearMask) | (bit << plane);
        }
        bodyBitPos++;
      }
    }
  }
}

function extractScatteredEncryptedBody(data, bodyLen, maxPlanes, stats, feistelKeys) {
  const locator = createBodyPixelLocator(data, stats, HEADER_OPAQUE_PIXELS_ENCRYPTED);
  const permute = createFeistelPermuter(locator.count, feistelKeys);
  const bodyBytes = new Uint8Array(bodyLen);
  const bodyBits = bodyLen * 8;
  let bodyBitPos = 0;

  for (let plane = 0; plane < maxPlanes && bodyBitPos < bodyBits; plane++) {
    for (let k = 0; k < locator.count && bodyBitPos < bodyBits; k++) {
      const pixelOffset = locator.byteOffsetAt(permute(k));
      for (let c = 0; c < 3 && bodyBitPos < bodyBits; c++) {
        const bit = (data[pixelOffset + c] >>> plane) & 1;
        bodyBytes[bodyBitPos >>> 3] = (bodyBytes[bodyBitPos >>> 3] << 1) | bit;
        bodyBitPos++;
      }
    }
  }

  return bodyBitPos === bodyBits ? bodyBytes : null;
}

// Cursor continuo sobre planos 0..maxPlanes-1 en R/G/B de píxeles opacos (A=255).
function createBitReader(data, maxPlanes = 8) {
  let plane = 0;
  let p = 0;
  let c = 0;
  const len = data.length;

  function readBit() {
    while (plane < maxPlanes) {
      while (p < len) {
        if (data[p + 3] === 255) {
          const bit = (data[p + c] >>> plane) & 1;
          c += 1;
          if (c === 3) {
            c = 0;
            p += 4;
          }
          return bit;
        }
        p += 4;
        c = 0;
      }
      plane += 1;
      p = 0;
      c = 0;
    }
    return -1;
  }

  function readBytes(count) {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (let b = 0; b < 8; b++) {
        const bit = readBit();
        if (bit === -1) return null;
        value = (value << 1) | bit;
      }
      bytes[i] = value;
    }
    return bytes;
  }

  return { readBytes };
}

function matchesMagic(bytes, magic) {
  return (
    bytes &&
    bytes.length >= 4 &&
    bytes[0] === magic[0] &&
    bytes[1] === magic[1] &&
    bytes[2] === magic[2] &&
    bytes[3] === magic[3]
  );
}

export function inspectImageData(imageData, stats) {
  const imgStats = stats || analyzeImageData(imageData);
  const reader = createBitReader(imageData.data, 1);
  const magic = reader.readBytes(4);

  if (!magic) {
    return { found: false };
  }

  if (matchesMagic(magic, MAGIC_V1)) {
    const lenBytes = reader.readBytes(4);
    if (!lenBytes) {
      throw new Error('La cabecera STG1 está incompleta o la imagen fue recortada.');
    }

    const bodyLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, false);
    const totalBits = (HEADER_BYTES_V1 + bodyLen) * 8;

    if (bodyLen === 0 || totalBits > imgStats.losslessBits) {
      throw new Error(
        'La cabecera del mensaje está dañada o la longitud declarada excede la capacidad de la imagen.'
      );
    }

    const quality = estimateQuality(totalBits, imgStats.opaquePixels);
    return {
      found: true,
      version: 1,
      headerBytes: HEADER_BYTES_V1,
      headerRaw: null,
      flags: 0,
      encrypted: false,
      compressed: false,
      isFile: false,
      scattered: false,
      multibit: false,
      bodyLen,
      crc32: null,
      kdfFactor: null,
      kdfIterations: null,
      salt: null,
      iv: null,
      usedBits: totalBits,
      planesUsed: quality.planesUsed,
      quality
    };
  }

  if (matchesMagic(magic, MAGIC_V2)) {
    const fixedMeta = reader.readBytes(5);
    if (!fixedMeta) {
      throw new Error('La cabecera STG2 está incompleta o la imagen fue recortada.');
    }

    const flags = fixedMeta[0];
    if ((flags & ~KNOWN_FLAGS_MASK) !== 0) {
      throw new Error(
        'La cabecera STG2 contiene banderas desconocidas o de una versión no soportada.'
      );
    }

    const encrypted = (flags & FLAGS.ENCRYPTED) !== 0;
    const compressed = (flags & FLAGS.COMPRESSED) !== 0;
    const isFile = (flags & FLAGS.FILE) !== 0;
    const scattered = (flags & FLAGS.SCATTERED) !== 0;
    const multibit = (flags & FLAGS.MULTIBIT) !== 0;

    if (scattered && !encrypted) {
      throw new Error('La cabecera STG2 es inválida: la dispersión requiere cifrado.');
    }

    const bodyLen = new DataView(fixedMeta.buffer, fixedMeta.byteOffset + 1, 4).getUint32(0, false);

    if (!encrypted) {
      const crcBytes = reader.readBytes(4);
      if (!crcBytes) {
        throw new Error('La cabecera STG2 está incompleta o la imagen fue recortada.');
      }

      const expectedCrc = new DataView(crcBytes.buffer, crcBytes.byteOffset, 4).getUint32(0, false);
      const totalBits = (HEADER_BYTES_V2 + bodyLen) * 8;
      const maxAllowedBits = multibit ? imgStats.maxTotalBits : imgStats.losslessBits;

      if (
        bodyLen < 1 ||
        totalBits > maxAllowedBits ||
        multibit !== (totalBits > imgStats.losslessBits)
      ) {
        throw new Error(
          'La cabecera STG2 está dañada o la longitud declarada excede la capacidad de la imagen.'
        );
      }

      const headerRaw = new Uint8Array(HEADER_BYTES_V2);
      headerRaw.set(magic, 0);
      headerRaw.set(fixedMeta, 4);
      headerRaw.set(crcBytes, 9);

      const quality = estimateQuality(totalBits, imgStats.opaquePixels);
      return {
        found: true,
        version: 2,
        headerBytes: HEADER_BYTES_V2,
        headerRaw,
        flags,
        encrypted: false,
        compressed,
        isFile,
        scattered: false,
        multibit,
        bodyLen,
        crc32: expectedCrc,
        kdfFactor: null,
        kdfIterations: null,
        salt: null,
        iv: null,
        usedBits: totalBits,
        planesUsed: quality.planesUsed,
        quality
      };
    }

    // Cabecera STG2 cifrada (39 B): byte 9 kdfFactor, 10..25 salt, 26..37 iv, 38 reserved = 0.
    const encExt = reader.readBytes(HEADER_BYTES_V2_ENCRYPTED - 9);
    if (!encExt) {
      throw new Error('La cabecera STG2 cifrada está incompleta o la imagen fue recortada.');
    }

    const kdfFactor = encExt[0];
    const salt = encExt.slice(1, 17);
    const iv = encExt.slice(17, 29);
    const reserved = encExt[29];

    if (reserved !== 0) {
      throw new Error('La cabecera STG2 cifrada contiene un byte reservado inválido.');
    }
    if (kdfFactor < MIN_KDF_FACTOR || kdfFactor > MAX_KDF_FACTOR) {
      throw new Error('La cabecera STG2 cifrada declara un factor KDF fuera del rango permitido.');
    }
    if (bodyLen < GCM_TAG_BYTES + 1) {
      throw new Error('La cabecera STG2 cifrada declara una longitud de cuerpo inválida.');
    }

    const bodyBits = bodyLen * 8;
    const totalBits = (HEADER_BYTES_V2_ENCRYPTED + bodyLen) * 8;
    let quality;

    if (scattered) {
      const remainingOpaque = imgStats.opaquePixels - HEADER_OPAQUE_PIXELS_ENCRYPTED;
      const maxBodyBits = multibit ? remainingOpaque * 24 : remainingOpaque * 3;
      if (
        remainingOpaque <= 0 ||
        bodyBits > maxBodyBits ||
        multibit !== (bodyBits > remainingOpaque * 3)
      ) {
        throw new Error(
          'La cabecera STG2 cifrada está dañada o la longitud declarada excede la capacidad de la imagen.'
        );
      }
      quality = estimateScatteredQuality(bodyBits, imgStats.opaquePixels);
    } else {
      const maxAllowedBits = multibit ? imgStats.maxTotalBits : imgStats.losslessBits;
      if (
        imgStats.losslessBits < HEADER_BYTES_V2_ENCRYPTED * 8 ||
        totalBits > maxAllowedBits ||
        multibit !== (totalBits > imgStats.losslessBits)
      ) {
        throw new Error(
          'La cabecera STG2 cifrada está dañada o la longitud declarada excede la capacidad de la imagen.'
        );
      }
      quality = estimateQuality(totalBits, imgStats.opaquePixels);
    }

    const headerRaw = new Uint8Array(HEADER_BYTES_V2_ENCRYPTED);
    headerRaw.set(magic, 0);
    headerRaw.set(fixedMeta, 4);
    headerRaw.set(encExt, 9);

    return {
      found: true,
      version: 2,
      headerBytes: HEADER_BYTES_V2_ENCRYPTED,
      headerRaw,
      flags,
      encrypted: true,
      compressed,
      isFile,
      scattered,
      multibit,
      bodyLen,
      crc32: null,
      kdfFactor,
      kdfIterations: kdfFactor * 10_000,
      salt,
      iv,
      usedBits: totalBits,
      planesUsed: quality.planesUsed,
      quality
    };
  }

  return { found: false };
}

export function encodeImageData(imageData, message, options = {}) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error('Escribe un mensaje antes de codificar.');
  }

  const { stats: providedStats, allowMultibit = true } = options || {};
  const stats = providedStats || analyzeImageData(imageData);
  const msgBytes = encoder.encode(message);

  if (stats.losslessBits < HEADER_BYTES_V2 * 8) {
    throw new Error(
      'Esta imagen no tiene suficientes píxeles opacos (A = 255) para guardar la cabecera STG2.'
    );
  }

  const maxAllowedBytes = allowMultibit ? stats.maxTotalBytes : stats.losslessBytes;
  if (msgBytes.length > maxAllowedBytes) {
    throw new Error(
      `El mensaje ocupa ${msgBytes.length} bytes, pero esta imagen solo admite ${maxAllowedBytes} bytes.`
    );
  }

  const totalBits = (HEADER_BYTES_V2 + msgBytes.length) * 8;
  const flags = totalBits > stats.losslessBits ? FLAGS.MULTIBIT : 0;
  const checksum = crc32(msgBytes);

  // Cabecera STG2 (13 B): "STG2" + flags (1 B) + bodyLen (4 B BE) + crc32 (4 B BE).
  const payload = new Uint8Array(HEADER_BYTES_V2 + msgBytes.length);
  payload.set(MAGIC_V2, 0);
  payload[4] = flags;
  const view = new DataView(payload.buffer);
  view.setUint32(5, msgBytes.length, false);
  view.setUint32(9, checksum, false);
  payload.set(msgBytes, HEADER_BYTES_V2);

  const out = new Uint8ClampedArray(imageData.data);
  embedSequentialBytes(out, payload, createRandomBitSource());

  const quality = estimateQuality(totalBits, stats.opaquePixels);

  return {
    data: out,
    width: imageData.width,
    height: imageData.height,
    version: 2,
    flags,
    messageBytes: msgBytes.length,
    usedBits: totalBits,
    planesUsed: quality.planesUsed,
    quality,
    ...stats
  };
}

export function decodeImageData(imageData, stats) {
  const imgStats = stats || analyzeImageData(imageData);
  const meta = inspectImageData(imageData, imgStats);

  if (!meta.found) {
    throw new Error(
      'No se encontró ningún mensaje oculto en esta imagen. Verifica que sea el PNG original sin compresión.'
    );
  }

  if (meta.version === 2) {
    if (meta.encrypted) {
      throw new Error(
        'Esta imagen contiene un mensaje STG2 cifrado. Usa decodePayload() con la contraseña para descifrarlo.'
      );
    }
    if (meta.compressed || meta.isFile) {
      throw new Error(
        'Esta imagen usa compresión o archivo embebido STG2. Usa decodePayload() para leerla.'
      );
    }
  }

  const maxPlanes = meta.version === 2 && meta.multibit ? 8 : 1;
  const reader = createBitReader(imageData.data, maxPlanes);
  const skippedHeader = reader.readBytes(meta.headerBytes);
  if (!skippedHeader) {
    throw new Error('Los bits de la cabecera están incompletos o la imagen fue recortada.');
  }

  const msgBytes = reader.readBytes(meta.bodyLen);
  if (!msgBytes) {
    throw new Error('Los bits del mensaje están incompletos o la imagen fue recortada.');
  }

  if (meta.version === 2) {
    const actualCrc = crc32(msgBytes);
    if (actualCrc !== meta.crc32) {
      throw new Error(
        'La verificación de integridad (CRC-32) falló: el mensaje está dañado o la imagen fue alterada/recomprimida.'
      );
    }
  }

  let message;
  try {
    message = decoder.decode(msgBytes);
  } catch {
    throw new Error(
      'No se pudo interpretar el texto UTF-8. Es probable que la imagen haya sido recomprimida.'
    );
  }

  return {
    message,
    version: meta.version,
    flags: meta.flags,
    messageBytes: meta.bodyLen,
    usedBits: meta.usedBits,
    planesUsed: meta.planesUsed,
    quality: meta.quality,
    ...imgStats
  };
}

export async function encodePayload(imageData, message, options = {}) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error('Escribe un mensaje antes de codificar.');
  }

  const {
    password = '',
    compress = false,
    scatter = true,
    allowMultibit = true,
    stats: providedStats,
    kdfIterations = DEFAULT_KDF_ITERATIONS
  } = options || {};

  const stats = providedStats || analyzeImageData(imageData);
  const rawBytes = encoder.encode(message);
  const encrypted = typeof password === 'string' && password.length > 0;
  const scattered = encrypted && Boolean(scatter);

  if (encrypted && !isCryptoSupported()) {
    throw createCodedError(
      'CRYPTO_UNSUPPORTED',
      'Tu navegador no habilita Web Crypto API (crypto.subtle) en este contexto. Ábrelo desde HTTPS (GitHub Pages) o localhost.'
    );
  }

  // Comprimir siempre antes de cifrar; omitir automáticamente si no reduce el tamaño.
  let workingBytes = rawBytes;
  let compressed = false;
  if (compress && isCompressionSupported()) {
    const zipped = await compressRaw(rawBytes);
    if (zipped.length < rawBytes.length) {
      workingBytes = zipped;
      compressed = true;
    }
  }

  const headerBytesLen = getHeaderBytes({ encrypted });
  const bodyLen = encrypted ? workingBytes.length + GCM_TAG_BYTES : workingBytes.length;

  if (stats.losslessBits < headerBytesLen * 8) {
    throw new Error(
      'Esta imagen no tiene suficientes píxeles opacos (A = 255) para guardar la cabecera STG2.'
    );
  }

  const capacity = getCapacityBytes(stats, { encrypted, scattered });
  const maxAllowedPlainBytes = allowMultibit ? capacity.maxTotalBytes : capacity.losslessBytes;
  if (workingBytes.length > maxAllowedPlainBytes) {
    throw new Error(
      `El payload ocupa ${workingBytes.length} bytes, pero esta imagen solo admite ${maxAllowedPlainBytes} bytes.`
    );
  }

  const remainingOpaque = stats.opaquePixels - HEADER_OPAQUE_PIXELS_ENCRYPTED;
  const bodyBits = bodyLen * 8;
  const totalBits = (headerBytesLen + bodyLen) * 8;
  const multibit = scattered
    ? bodyBits > remainingOpaque * 3
    : totalBits > stats.losslessBits;

  let flags = 0;
  if (encrypted) flags |= FLAGS.ENCRYPTED;
  if (compressed) flags |= FLAGS.COMPRESSED;
  if (scattered) flags |= FLAGS.SCATTERED;
  if (multibit) flags |= FLAGS.MULTIBIT;

  const out = new Uint8ClampedArray(imageData.data);
  const nextRandBit = createRandomBitSource();
  let quality;

  if (!encrypted) {
    const checksum = crc32(workingBytes);
    const payload = new Uint8Array(HEADER_BYTES_V2 + bodyLen);
    payload.set(MAGIC_V2, 0);
    payload[4] = flags;
    const view = new DataView(payload.buffer);
    view.setUint32(5, bodyLen, false);
    view.setUint32(9, checksum, false);
    payload.set(workingBytes, HEADER_BYTES_V2);

    embedSequentialBytes(out, payload, nextRandBit);
    quality = estimateQuality(totalBits, stats.opaquePixels);
  } else {
    const kdfFactor = Math.round(kdfIterations / 10_000);
    if (
      !Number.isFinite(kdfIterations) ||
      kdfFactor < MIN_KDF_FACTOR ||
      kdfFactor > MAX_KDF_FACTOR ||
      kdfFactor * 10_000 !== kdfIterations
    ) {
      throw new Error(
        `kdfIterations debe ser múltiplo de 10.000 entre ${MIN_KDF_FACTOR * 10_000} y ${MAX_KDF_FACTOR * 10_000}.`
      );
    }

    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(salt);
    globalThis.crypto.getRandomValues(iv);

    // Cabecera STG2 cifrada (39 B) usada también como AAD en AES-256-GCM.
    const headerRaw = new Uint8Array(HEADER_BYTES_V2_ENCRYPTED);
    headerRaw.set(MAGIC_V2, 0);
    headerRaw[4] = flags;
    new DataView(headerRaw.buffer).setUint32(5, bodyLen, false);
    headerRaw[9] = kdfFactor;
    headerRaw.set(salt, 10);
    headerRaw.set(iv, 26);
    headerRaw[38] = 0;

    const { aesKey, feistelKeys } = await deriveKeys(password, salt, kdfFactor * 10_000);
    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: headerRaw, tagLength: 128 },
      aesKey,
      workingBytes
    );
    const storedBody = new Uint8Array(cipherBuf);

    if (scattered) {
      embedScatteredEncrypted(out, headerRaw, storedBody, stats, feistelKeys, nextRandBit);
      quality = estimateScatteredQuality(bodyBits, stats.opaquePixels);
    } else {
      const payload = new Uint8Array(HEADER_BYTES_V2_ENCRYPTED + storedBody.length);
      payload.set(headerRaw, 0);
      payload.set(storedBody, HEADER_BYTES_V2_ENCRYPTED);
      embedSequentialBytes(out, payload, nextRandBit);
      quality = estimateQuality(totalBits, stats.opaquePixels);
    }
  }

  return {
    data: out,
    width: imageData.width,
    height: imageData.height,
    version: 2,
    flags,
    encrypted,
    compressed,
    scattered,
    multibit,
    originalBytes: rawBytes.length,
    compressedBytes: workingBytes.length,
    storedBytes: bodyLen,
    messageBytes: rawBytes.length,
    usedBits: totalBits,
    planesUsed: quality.planesUsed,
    quality,
    ...stats
  };
}

export async function decodePayload(imageData, options = {}) {
  const {
    password = '',
    stats: providedStats,
    maxDecompressedBytes = MAX_DECOMPRESSED_BYTES
  } = options || {};

  const imgStats = providedStats || analyzeImageData(imageData);
  const meta = inspectImageData(imageData, imgStats);

  if (!meta.found) {
    throw new Error(
      'No se encontró ningún mensaje oculto en esta imagen. Verifica que sea el PNG original sin compresión.'
    );
  }

  if (meta.version === 1) {
    const legacy = decodeImageData(imageData, imgStats);
    return {
      ...legacy,
      encrypted: false,
      compressed: false,
      scattered: false,
      multibit: false,
      originalBytes: legacy.messageBytes,
      compressedBytes: legacy.messageBytes,
      storedBytes: legacy.messageBytes
    };
  }

  if (meta.isFile) {
    throw new Error(
      'Esta imagen contiene un archivo embebido STG2 que aún no es soportado por esta versión.'
    );
  }

  const maxPlanes = meta.multibit ? 8 : 1;
  let workingBytes;

  if (meta.encrypted) {
    if (!isCryptoSupported()) {
      throw createCodedError(
        'CRYPTO_UNSUPPORTED',
        'Tu navegador no habilita Web Crypto API (crypto.subtle) en este contexto. Ábrelo desde HTTPS (GitHub Pages) o localhost.'
      );
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw createCodedError(
        'PASSWORD_REQUIRED',
        'Esta imagen contiene un mensaje cifrado. Ingresa la contraseña para descifrarlo.'
      );
    }

    const { aesKey, feistelKeys } = await deriveKeys(password, meta.salt, meta.kdfIterations);
    let storedBody;

    if (meta.scattered) {
      storedBody = extractScatteredEncryptedBody(
        imageData.data,
        meta.bodyLen,
        maxPlanes,
        imgStats,
        feistelKeys
      );
    } else {
      const reader = createBitReader(imageData.data, maxPlanes);
      const skipped = reader.readBytes(meta.headerBytes);
      storedBody = skipped ? reader.readBytes(meta.bodyLen) : null;
    }

    if (!storedBody) {
      throw new Error('Los bits del mensaje cifrado están incompletos o la imagen fue recortada.');
    }

    try {
      const plainBuf = await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: meta.iv,
          additionalData: meta.headerRaw,
          tagLength: 128
        },
        aesKey,
        storedBody
      );
      workingBytes = new Uint8Array(plainBuf);
    } catch {
      throw createCodedError(
        'WRONG_PASSWORD',
        'Contraseña incorrecta o la imagen fue alterada/recomprimida.'
      );
    }
  } else {
    const reader = createBitReader(imageData.data, maxPlanes);
    const skipped = reader.readBytes(meta.headerBytes);
    if (!skipped) {
      throw new Error('Los bits de la cabecera están incompletos o la imagen fue recortada.');
    }
    const storedBody = reader.readBytes(meta.bodyLen);
    if (!storedBody) {
      throw new Error('Los bits del mensaje están incompletos o la imagen fue recortada.');
    }

    // En STG2 sin cifrar (con o sin compresión), validar CRC-32 sobre storedBody antes de descomprimir.
    if (crc32(storedBody) !== meta.crc32) {
      throw new Error(
        'La verificación de integridad (CRC-32) falló: el mensaje está dañado o la imagen fue alterada/recomprimida.'
      );
    }
    workingBytes = storedBody;
  }

  const compressedBytes = workingBytes.length;
  const rawBytes = meta.compressed
    ? await decompressRaw(workingBytes, maxDecompressedBytes)
    : workingBytes;

  let message;
  try {
    message = decoder.decode(rawBytes);
  } catch {
    throw new Error(
      'No se pudo interpretar el texto UTF-8. Es probable que la imagen haya sido recomprimida.'
    );
  }

  return {
    message,
    version: 2,
    flags: meta.flags,
    encrypted: meta.encrypted,
    compressed: meta.compressed,
    scattered: meta.scattered,
    multibit: meta.multibit,
    originalBytes: rawBytes.length,
    compressedBytes,
    storedBytes: meta.bodyLen,
    messageBytes: rawBytes.length,
    usedBits: meta.usedBits,
    planesUsed: meta.planesUsed,
    quality: meta.quality,
    ...imgStats
  };
}

export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('Selecciona un archivo de imagen válido.'));
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
        if (!ctx || canvas.width === 0 || canvas.height === 0) {
          throw new Error('No se pudo leer la imagen en el lienzo del navegador.');
        }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        resolve({
          fileName: file.name,
          fileType: file.type,
          previewUrl,
          imageData,
          ...analyzeImageData(imageData)
        });
      } catch (err) {
        URL.revokeObjectURL(previewUrl);
        reject(err instanceof Error ? err : new Error('Error al procesar la imagen.'));
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(previewUrl);
      reject(new Error('No se pudo cargar el archivo de imagen seleccionado.'));
    };

    img.src = previewUrl;
  });
}

export function imageDataToPngBlob(data, width, height) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx) {
      reject(new Error('No se pudo inicializar el lienzo para exportar el PNG.'));
      return;
    }

    ctx.putImageData(new ImageData(data, width, height), 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('No se pudo generar el archivo PNG de salida.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`selfCheck falló: ${message}`);
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

async function assertRejects(fn, expectedCode, message) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, message);
  if (expectedCode) {
    assert(caught.code === expectedCode, `${message} (esperado ${expectedCode}, recibido ${caught.code})`);
  }
}

function createTestFixture(width, height, withAlphaMix = true) {
  const totalPixels = width * height;
  const raw = new Uint8ClampedArray(totalPixels * 4);
  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    raw[i] = (p * 17) % 256;
    raw[i + 1] = (p * 43) % 256;
    raw[i + 2] = (p * 71) % 256;
    raw[i + 3] = withAlphaMix ? (p % 5 === 0 ? 0 : p % 5 === 1 ? 128 : 255) : 255;
  }
  return { width, height, data: raw };
}

// Helper interno solo para pruebas de retrocompatibilidad STG1 en selfCheckSync().
function encodeLegacyV1ForTest(imageData, message) {
  const msgBytes = encoder.encode(message);
  const payload = new Uint8Array(HEADER_BYTES_V1 + msgBytes.length);
  payload.set(MAGIC_V1, 0);
  new DataView(payload.buffer).setUint32(4, msgBytes.length, false);
  payload.set(msgBytes, HEADER_BYTES_V1);

  const out = new Uint8ClampedArray(imageData.data);
  const totalBits = payload.length * 8;
  let bitPos = 0;

  for (let i = 0; i < out.length && bitPos < totalBits; i += 4) {
    if (out[i + 3] !== 255) continue;
    for (let c = 0; c < 3 && bitPos < totalBits; c++) {
      const bit = (payload[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
      out[i + c] = (out[i + c] & 0xfe) | bit;
      bitPos++;
    }
  }

  return { width: imageData.width, height: imageData.height, data: out };
}

function nthOpaquePixelByteOffset(data, n) {
  let seen = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255) {
      if (seen === n) return i;
      seen++;
    }
  }
  return -1;
}

export function selfCheckSync() {
  // 1. Vector estándar IEEE 802.3 para CRC-32 y tamaños de cabecera/overhead.
  assert(crc32(encoder.encode('123456789')) === 0xcbf43926, 'CRC-32 debe cumplir IEEE 802.3');
  assert(getHeaderBytes() === HEADER_BYTES_V2, 'getHeaderBytes() debe devolver 13');
  assert(getHeaderBytes({ encrypted: true }) === HEADER_BYTES_V2_ENCRYPTED, 'getHeaderBytes(encrypted) debe devolver 39');
  assert(getOverheadBytes() === HEADER_BYTES_V2, 'getOverheadBytes() debe devolver 13');
  assert(getOverheadBytes({ encrypted: true }) === 55, 'getOverheadBytes(encrypted) debe devolver 55');

  // 2. Borde < 35 píxeles opacos → sin capacidad STG2.
  const tinyRaw = new Uint8ClampedArray(34 * 4);
  for (let i = 3; i < tinyRaw.length; i += 4) tinyRaw[i] = 255;
  const tinyStats = analyzeImageData({ width: 34, height: 1, data: tinyRaw });
  assert(tinyStats.losslessBytes === 0 && tinyStats.maxTotalBytes === 0, '<35 opacos da 0 B');

  // 3. Fixture 64×64 mezclando A=0, A=128 y A=255.
  const fakeImg = createTestFixture(64, 64, true);
  const { width, height, data: raw } = fakeImg;
  const totalPixels = width * height;
  const stats = analyzeImageData(fakeImg);
  assert(stats.losslessBytes > 800, 'fixture 64×64 debe superar 800 B en plano 0');
  assert(stats.maxTotalBytes > 7000, 'fixture 64×64 debe superar 7000 B en 8 planos');
  assert(computePsnr(raw, raw) === Infinity, 'PSNR de imágenes idénticas debe ser Infinity');
  assert(inspectImageData(fakeImg).found === false, 'imagen limpia devuelve found: false');

  // 4. Retrocompatibilidad STG1 legacy.
  const legacyText = 'Mensaje STG1 legacy ¡Ñandú! 🔐';
  const legacyImg = encodeLegacyV1ForTest(fakeImg, legacyText);
  const legacyMeta = inspectImageData(legacyImg);
  assert(legacyMeta.found && legacyMeta.version === 1, 'inspect debe reconocer STG1');
  const legacyDecoded = decodeImageData(legacyImg);
  assert(
    legacyDecoded.version === 1 && legacyDecoded.message === legacyText,
    'decode debe leer STG1 legacy exactamente'
  );

  // 5. STG2 plano 0 (sin pérdida, LSB Matching ±1).
  const sample = 'Hola mundo! Ñandú 🔐🚀\nLínea 2';
  const enc1 = encodeImageData(fakeImg, sample, { stats });
  assert(
    enc1.version === 2 && enc1.flags === 0 && enc1.planesUsed === 1,
    'STG2 corto debe usar plano 0 sin FLAG MULTIBIT'
  );
  assert(enc1.quality.level === 'lossless', 'calidad en plano 0 debe ser lossless');
  const dec1 = decodeImageData({ width, height, data: enc1.data });
  assert(dec1.version === 2 && dec1.message === sample, 'STG2 plano 0 debe coincidir exactamente');

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    assert(enc1.data[i + 3] === raw[i + 3], 'canal alpha intacto en plano 0');
    if (raw[i + 3] !== 255) {
      for (let c = 0; c < 4; c++) {
        assert(enc1.data[i + c] === raw[i + c], 'píxeles no opacos intactos en plano 0');
      }
    } else {
      for (let c = 0; c < 3; c++) {
        assert(Math.abs(enc1.data[i + c] - raw[i + c]) <= 1, 'RGB opaco cambia ≤ 1 en plano 0');
      }
    }
  }
  const psnr1 = computePsnr(raw, enc1.data);

  // 6. STG2 multi-plano: planos 0..3 (4 planos).
  const msg4 = 'ABCD0123456789efgh'.repeat(200).slice(0, Math.floor(stats.losslessBytes * 3.5));
  const enc4 = encodeImageData(fakeImg, msg4, { stats });
  assert(
    (enc4.flags & FLAGS.MULTIBIT) !== 0 && enc4.planesUsed === 4 && enc4.quality.level === 'visible',
    'STG2 en 4 planos debe activar MULTIBIT y nivel visible'
  );
  const dec4 = decodeImageData({ width, height, data: enc4.data });
  assert(dec4.message === msg4 && dec4.planesUsed === 4, 'STG2 en 4 planos debe decodificar exacto');
  let maxDelta4 = 0;
  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    assert(enc4.data[i + 3] === raw[i + 3], 'canal alpha intacto en 4 planos');
    if (raw[i + 3] !== 255) {
      for (let c = 0; c < 4; c++) {
        assert(enc4.data[i + c] === raw[i + c], 'píxeles no opacos intactos en 4 planos');
      }
    } else {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(enc4.data[i + c] - raw[i + c]);
        if (d > maxDelta4) maxDelta4 = d;
      }
    }
  }
  assert(maxDelta4 > 1 && maxDelta4 <= 15, 'delta en 4 planos debe superar 1 y ser ≤ 15');
  const psnr4 = computePsnr(raw, enc4.data);

  // 7. STG2 multi-plano: planos 0..7 (capacidad máxima 8 planos).
  const pattern = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#';
  const msg8 = pattern.repeat(Math.ceil(stats.maxTotalBytes / pattern.length)).slice(0, stats.maxTotalBytes);
  const enc8 = encodeImageData(fakeImg, msg8, { stats });
  assert(
    (enc8.flags & FLAGS.MULTIBIT) !== 0 &&
      enc8.planesUsed === 8 &&
      enc8.quality.level === 'destroyed' &&
      enc8.usedBits === stats.maxTotalBits,
    'STG2 a capacidad máxima debe ocupar los 8 planos'
  );
  const dec8 = decodeImageData({ width, height, data: enc8.data });
  assert(dec8.message === msg8 && dec8.planesUsed === 8, 'STG2 en 8 planos debe decodificar exacto');
  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    assert(enc8.data[i + 3] === raw[i + 3], 'canal alpha intacto en 8 planos');
    if (raw[i + 3] !== 255) {
      for (let c = 0; c < 4; c++) {
        assert(enc8.data[i + c] === raw[i + c], 'píxeles no opacos intactos en 8 planos');
      }
    }
  }
  const psnr8 = computePsnr(raw, enc8.data);
  assert(psnr1 > psnr4 && psnr4 > psnr8, 'PSNR debe decrecer al subir de 1 → 4 → 8 planos');

  // 8. Detección de bit-flip en cuerpo ASCII puro vía CRC-32 (sigue siendo UTF-8 válido).
  const asciiMsg = 'Texto ASCII puro donde voltear 1 bit sigue siendo ASCII valido.';
  const encAscii = encodeImageData(fakeImg, asciiMsg, { stats });
  const flippedAscii = new Uint8ClampedArray(encAscii.data);
  const bodyPixelOffset = nthOpaquePixelByteOffset(flippedAscii, 37);
  assert(bodyPixelOffset >= 0, 'debe existir el píxel opaco #37');
  flippedAscii[bodyPixelOffset] ^= 1;
  assertThrows(
    () => decodeImageData({ width, height, data: flippedAscii }),
    'bit-flip en cuerpo ASCII debe fallar por CRC-32'
  );

  // 9. Validaciones de error (vacío, exceso, allowMultibit: false, sin cabecera, cabecera alterada).
  assertThrows(() => encodeImageData(fakeImg, ''), 'mensaje vacío debe lanzar error');
  assertThrows(
    () => encodeImageData(fakeImg, 'A'.repeat(stats.maxTotalBytes + 1), { stats }),
    'mensaje mayor a maxTotalBytes debe lanzar error'
  );
  assertThrows(
    () => encodeImageData(fakeImg, 'A'.repeat(stats.losslessBytes + 1), { stats, allowMultibit: false }),
    'exceso sobre plano 0 con allowMultibit: false debe lanzar error'
  );
  assertThrows(() => decodeImageData(fakeImg), 'imagen sin cabecera debe lanzar error');

  const corruptedHeader = new Uint8ClampedArray(enc1.data);
  const firstOpaque = nthOpaquePixelByteOffset(corruptedHeader, 0);
  corruptedHeader[firstOpaque] ^= 1;
  assertThrows(
    () => decodeImageData({ width, height, data: corruptedHeader }),
    'cabecera alterada debe lanzar error'
  );

  // 10. Rechazo claro de bandera SCATTERED sin ENCRYPTED y banderas desconocidas.
  const scatteredNoEnc = new Uint8ClampedArray(enc1.data);
  // Bit 36 = bit 3 de byte 4 (FLAGS.SCATTERED = 0x08) → píxel opaco #12, canal R.
  scatteredNoEnc[nthOpaquePixelByteOffset(scatteredNoEnc, 12)] ^= 1;
  assertThrows(
    () => inspectImageData({ width, height, data: scatteredNoEnc }),
    'SCATTERED sin ENCRYPTED debe ser rechazado'
  );

  const encFlagImg = new Uint8ClampedArray(enc1.data);
  // Bit 39 = bit 0 de byte 4 (FLAGS.ENCRYPTED = 0x01) → píxel opaco #13, canal R.
  encFlagImg[nthOpaquePixelByteOffset(encFlagImg, 13)] ^= 1;
  assertThrows(
    () => decodeImageData({ width, height, data: encFlagImg }),
    'FLAG ENCRYPTED debe ser rechazado en decodeImageData síncrono'
  );

  return true;
}

export async function selfCheck() {
  assert(selfCheckSync() === true, 'selfCheckSync debe pasar');

  const fakeImg = createTestFixture(64, 64, true);
  const stats = analyzeImageData(fakeImg);
  const opaqueImg = createTestFixture(48, 48, false);
  const opaqueStats = analyzeImageData(opaqueImg);

  // 1. Compresión deflate-raw + auto-omisión + defensa anti-zip-bomb.
  if (isCompressionSupported()) {
    const repetitive = 'Stego LSB compresión deflate-raw Ñandú 🔐! '.repeat(35);
    const encZip = await encodePayload(fakeImg, repetitive, { compress: true, stats });
    assert(
      encZip.compressed && encZip.storedBytes < encZip.originalBytes && encZip.planesUsed === 1,
      'deflate-raw debe comprimir texto repetitivo y caber en plano 0'
    );
    const decZip = await decodePayload({ width: 64, height: 64, data: encZip.data });
    assert(decZip.message === repetitive && decZip.compressed, 'decodePayload debe descomprimir exacto');

    // Auto-omisión en texto muy corto.
    const encShort = await encodePayload(fakeImg, 'Hola!', { compress: true, stats });
    assert(encShort.compressed === false, 'deflate-raw debe omitirse si no ahorra bytes');
    const decShort = await decodePayload({ width: 64, height: 64, data: encShort.data });
    assert(decShort.message === 'Hola!', 'decodePayload corto sin compresión debe coincidir');

    // Defensa anti-zip-bomb (64 KB de ceros comprimidos → rechazar con límite de 1 KB).
    const bombInput = new Uint8Array(65536);
    const bombCompressed = await compressRaw(bombInput);
    assert(bombCompressed.length < 512, 'fixture zip-bomb debe comprimirse fuertemente');
    await assertRejects(
      () => decompressRaw(bombCompressed, 1024),
      'DECOMPRESSION_LIMIT',
      'decompressRaw debe abortar al superar maxBytes'
    );
  }

  // 2. Cifrado AES-256-GCM + PBKDF2/HKDF + dispersión Feistel (plano 0 y multi-plano).
  if (isCryptoSupported()) {
    const pass = 'Clave-Secreta-2026!#';
    const secret = 'Secreto cifrado con AES-256-GCM y Feistel O(1) — Ñandú 🔐🚀\n'.repeat(12);

    // 2a. Plano 0 con alpha mixto + compresión + Feistel.
    const encSec = await encodePayload(fakeImg, secret, {
      password: pass,
      compress: isCompressionSupported(),
      scatter: true,
      kdfIterations: 100_000,
      stats
    });
    assert(
      encSec.encrypted && encSec.scattered && encSec.planesUsed === 1,
      'cifrado + Feistel plano 0 debe reportar flags correctos'
    );
    for (let p = 0; p < 64 * 64; p++) {
      const i = p * 4;
      assert(encSec.data[i + 3] === fakeImg.data[i + 3], 'alpha intacto en cifrado plano 0');
      if (fakeImg.data[i + 3] !== 255) {
        for (let c = 0; c < 4; c++) {
          assert(encSec.data[i + c] === fakeImg.data[i + c], 'no-opaco intacto en cifrado plano 0');
        }
      } else {
        for (let c = 0; c < 3; c++) {
          assert(Math.abs(encSec.data[i + c] - fakeImg.data[i + c]) <= 1, 'RGB opaco ≤ ±1 en plano 0 cifrado');
        }
      }
    }

    const secImg = { width: 64, height: 64, data: encSec.data };
    const metaSec = inspectImageData(secImg);
    assert(
      metaSec.found && metaSec.version === 2 && metaSec.encrypted && metaSec.scattered && metaSec.kdfIterations === 100_000,
      'inspectImageData debe leer cabecera STG2 cifrada (39 B)'
    );
    assertThrows(() => decodeImageData(secImg), 'decodeImageData síncrono debe rechazar STG2 cifrado');

    await assertRejects(
      () => decodePayload(secImg),
      'PASSWORD_REQUIRED',
      'decodePayload sin clave debe exigir PASSWORD_REQUIRED'
    );
    await assertRejects(
      () => decodePayload(secImg, { password: 'clave-incorrecta' }),
      'WRONG_PASSWORD',
      'decodePayload con clave errónea debe fallar con WRONG_PASSWORD'
    );

    const decSec = await decodePayload(secImg, { password: pass });
    assert(
      decSec.message === secret && decSec.encrypted && decSec.scattered,
      'decodePayload con clave correcta debe recuperar el texto íntegro'
    );

    // 2b. Manipulación de AAD (voltear bit de FLAGS.COMPRESSED en byte 4 de cabecera → falla GCM).
    const tamperedAad = new Uint8ClampedArray(encSec.data);
    // Bit 38 = bit 1 de byte 4 (FLAGS.COMPRESSED = 0x02) → píxel opaco #12, canal B (+2).
    tamperedAad[nthOpaquePixelByteOffset(tamperedAad, 12) + 2] ^= 1;
    await assertRejects(
      () => decodePayload({ width: 64, height: 64, data: tamperedAad }, { password: pass }),
      'WRONG_PASSWORD',
      'manipular cabecera AAD debe fallar la autenticación AES-GCM'
    );

    // 2c. Ruta rápida O(1) RAM en imagen 100% opaca + Feistel.
    const encOpaque = await encodePayload(opaqueImg, 'Prueba ruta rápida opaca O(1) RAM', {
      password: pass,
      compress: false,
      scatter: true,
      kdfIterations: 100_000,
      stats: opaqueStats
    });
    const decOpaque = await decodePayload(
      { width: 48, height: 48, data: encOpaque.data },
      { password: pass }
    );
    assert(
      decOpaque.message === 'Prueba ruta rápida opaca O(1) RAM',
      'ruta rápida opaca O(1) Feistel debe recuperar exacto'
    );

    // 2d. Multi-plano cifrado + Feistel (planos 0..3 en fixture con alpha mixto).
    const bigPayload = Array.from({ length: 2400 }, (_, i) =>
      String.fromCharCode(33 + ((i * 37 + 13) % 90))
    ).join('');
    const encMultiSec = await encodePayload(fakeImg, bigPayload, {
      password: pass,
      compress: false,
      scatter: true,
      kdfIterations: 100_000,
      stats
    });
    assert(
      encMultiSec.encrypted && encMultiSec.scattered && encMultiSec.multibit && encMultiSec.planesUsed >= 3,
      'cifrado + Feistel multi-plano debe desbordar a planos >= 3'
    );
    for (let p = 0; p < 64 * 64; p++) {
      const i = p * 4;
      assert(encMultiSec.data[i + 3] === fakeImg.data[i + 3], 'alpha intacto en multi-plano cifrado');
      if (fakeImg.data[i + 3] !== 255) {
        for (let c = 0; c < 4; c++) {
          assert(encMultiSec.data[i + c] === fakeImg.data[i + c], 'no-opaco intacto en multi-plano cifrado');
        }
      }
    }
    const decMultiSec = await decodePayload(
      { width: 64, height: 64, data: encMultiSec.data },
      { password: pass }
    );
    assert(
      decMultiSec.message === bigPayload && decMultiSec.planesUsed === encMultiSec.planesUsed,
      'cifrado + Feistel multi-plano debe recuperar 100% del mensaje'
    );

    // 2e. Cifrado secuencial (scatter: false).
    const encSeq = await encodePayload(fakeImg, 'Cifrado secuencial sin Feistel', {
      password: pass,
      compress: false,
      scatter: false,
      kdfIterations: 100_000,
      stats
    });
    assert(encSeq.encrypted && !encSeq.scattered, 'scatter: false debe desactivar FLAG SCATTERED');
    const decSeq = await decodePayload(
      { width: 64, height: 64, data: encSeq.data },
      { password: pass }
    );
    assert(decSeq.message === 'Cifrado secuencial sin Feistel', 'cifrado secuencial debe recuperar exacto');
  }

  return true;
}

globalThis.Stego = {
  MAGIC_V1,
  HEADER_BYTES_V1,
  MAGIC_V2,
  HEADER_BYTES_V2,
  HEADER_BYTES_V2_ENCRYPTED,
  GCM_TAG_BYTES,
  MAGIC,
  HEADER_BYTES,
  FLAGS,
  WARN_PIXELS,
  MAX_DECOMPRESSED_BYTES,
  DEFAULT_KDF_ITERATIONS,
  utf8ByteLength,
  crc32,
  isCryptoSupported,
  isCompressionSupported,
  getHeaderBytes,
  getOverheadBytes,
  getCapacityBytes,
  analyzeImageData,
  estimateQuality,
  computePsnr,
  compressRaw,
  decompressRaw,
  deriveKeys,
  inspectImageData,
  encodeImageData,
  decodeImageData,
  encodePayload,
  decodePayload,
  loadImageFile,
  imageDataToPngBlob,
  selfCheckSync,
  selfCheck
};
