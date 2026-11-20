// Protocolo binario Stego LSB: soporte dual STG1 (legacy, 8 B) y STG2 (13 B + CRC-32 + 8 planos progresivos).
export const MAGIC_V1 = [0x53, 0x54, 0x47, 0x31]; // "STG1"
export const HEADER_BYTES_V1 = 8;

export const MAGIC_V2 = [0x53, 0x54, 0x47, 0x32]; // "STG2"
export const HEADER_BYTES_V2 = 13;

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

const KNOWN_FLAGS_MASK =
  FLAGS.ENCRYPTED | FLAGS.COMPRESSED | FLAGS.FILE | FLAGS.SCATTERED | FLAGS.MULTIBIT;
const ENCRYPTED_HEADER_BYTES_V2 = 39;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

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

export function utf8ByteLength(text) {
  return encoder.encode(text || '').length;
}

export function crc32(bytes) {
  const view =
    bytes instanceof Uint8Array
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);

  let crc = 0xffffffff;
  for (let i = 0; i < view.length; i++) {
    crc = CRC32_TABLE[(crc ^ view[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function getOverheadBytes() {
  return HEADER_BYTES_V2;
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
      flags: 0,
      encrypted: false,
      compressed: false,
      isFile: false,
      scattered: false,
      multibit: false,
      bodyLen,
      crc32: null,
      usedBits: totalBits,
      planesUsed: quality.planesUsed,
      quality
    };
  }

  if (matchesMagic(magic, MAGIC_V2)) {
    const rest = reader.readBytes(HEADER_BYTES_V2 - 4);
    if (!rest) {
      throw new Error('La cabecera STG2 está incompleta o la imagen fue recortada.');
    }

    const flags = rest[0];
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

    const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
    const bodyLen = view.getUint32(1, false);
    const expectedCrc = encrypted ? null : view.getUint32(5, false);
    const headerBytes = encrypted ? ENCRYPTED_HEADER_BYTES_V2 : HEADER_BYTES_V2;
    const totalBits = (headerBytes + bodyLen) * 8;
    const maxAllowedBits = multibit ? imgStats.maxTotalBits : imgStats.losslessBits;
    const minBodyLen = encrypted ? 17 : 1;

    if (
      bodyLen < minBodyLen ||
      totalBits > maxAllowedBits ||
      (!encrypted && multibit !== (totalBits > imgStats.losslessBits))
    ) {
      throw new Error(
        'La cabecera STG2 está dañada o la longitud declarada excede la capacidad de la imagen.'
      );
    }

    const quality = estimateQuality(totalBits, imgStats.opaquePixels);
    return {
      found: true,
      version: 2,
      headerBytes,
      flags,
      encrypted,
      compressed,
      isFile,
      scattered,
      multibit,
      bodyLen,
      crc32: expectedCrc,
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
  const nextRandBit = createRandomBitSource();
  let bitPos = 0;

  // Escritura progresiva por capas (plano 0 con LSB Matching ±1, planos 1..7 por máscara de bit).
  for (let plane = 0; plane < 8 && bitPos < totalBits; plane++) {
    if (plane === 0) {
      for (let i = 0; i < out.length && bitPos < totalBits; i += 4) {
        if (out[i + 3] !== 255) continue;

        for (let c = 0; c < 3 && bitPos < totalBits; c++) {
          const bit = (payload[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
          const val = out[i + c];
          if ((val & 1) !== bit) {
            if (val === 0) {
              out[i + c] = 1;
            } else if (val === 255) {
              out[i + c] = 254;
            } else {
              out[i + c] = val + (nextRandBit() ? 1 : -1);
            }
          }
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
        'Esta imagen contiene un mensaje STG2 cifrado. Esta versión aún no soporta descifrado con contraseña.'
      );
    }
    if (meta.compressed || meta.isFile) {
      throw new Error(
        'Esta imagen usa compresión o archivo embebido STG2 no soportado por esta versión.'
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

// Helper interno solo para pruebas de retrocompatibilidad STG1 en selfCheck().
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

export function selfCheck() {
  // 1. Vector estándar IEEE 802.3 para CRC-32.
  assert(crc32(encoder.encode('123456789')) === 0xcbf43926, 'CRC-32 debe cumplir IEEE 802.3');
  assert(getOverheadBytes() === HEADER_BYTES_V2, 'getOverheadBytes debe devolver 13');

  // 2. Borde < 35 píxeles opacos → sin capacidad STG2.
  const tinyRaw = new Uint8ClampedArray(34 * 4);
  for (let i = 3; i < tinyRaw.length; i += 4) tinyRaw[i] = 255;
  const tinyStats = analyzeImageData({ width: 34, height: 1, data: tinyRaw });
  assert(tinyStats.losslessBytes === 0 && tinyStats.maxTotalBytes === 0, '<35 opacos da 0 B');

  // 3. Fixture 64×64 mezclando A=0, A=128 y A=255.
  const width = 64;
  const height = 64;
  const totalPixels = width * height;
  const raw = new Uint8ClampedArray(totalPixels * 4);

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    raw[i] = (p * 17) % 256;
    raw[i + 1] = (p * 43) % 256;
    raw[i + 2] = (p * 71) % 256;
    raw[i + 3] = p % 5 === 0 ? 0 : p % 5 === 1 ? 128 : 255;
  }

  const fakeImg = { width, height, data: raw };
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
  // Bit 111 (LSB del primer byte del cuerpo: 104 bits de cabecera + 7) → píxel opaco #37, canal R.
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

  // 10. Rechazo claro de flags reservados/no soportados en STG2.
  const encFlagImg = new Uint8ClampedArray(enc1.data);
  // Byte 4 (flags) está en bits 32..39; bit 39 (LSB de flags = FLAGS.ENCRYPTED) es píxel opaco #13, canal R.
  const flagLsbOffset = nthOpaquePixelByteOffset(encFlagImg, 13);
  encFlagImg[flagLsbOffset] ^= 1;
  assertThrows(
    () => decodeImageData({ width, height, data: encFlagImg }),
    'FLAG ENCRYPTED debe ser rechazado con error claro'
  );

  return true;
}

globalThis.Stego = {
  MAGIC_V1,
  HEADER_BYTES_V1,
  MAGIC_V2,
  HEADER_BYTES_V2,
  MAGIC,
  HEADER_BYTES,
  FLAGS,
  WARN_PIXELS,
  utf8ByteLength,
  crc32,
  getOverheadBytes,
  analyzeImageData,
  estimateQuality,
  computePsnr,
  inspectImageData,
  encodeImageData,
  decodeImageData,
  loadImageFile,
  imageDataToPngBlob,
  selfCheck
};
