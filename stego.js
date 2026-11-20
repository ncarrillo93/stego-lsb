// Cabecera fija de 8 bytes: firma ASCII "STG1" + longitud uint32 big-endian.
export const MAGIC = [0x53, 0x54, 0x47, 0x31];
export const HEADER_BYTES = 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8ByteLength(text) {
  return encoder.encode(text || '').length;
}

export function analyzeImageData(imageData) {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  let opaquePixels = 0;

  // Solo usamos pixeles con A=255 porque Canvas premultiplica alfa y redondea RGB si A<255.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255) {
      opaquePixels++;
    }
  }

  const usableBits = opaquePixels * 3;
  const maxMessageBytes = Math.max(0, Math.floor(usableBits / 8) - HEADER_BYTES);

  return {
    width,
    height,
    totalPixels,
    opaquePixels,
    usableBits,
    maxMessageBytes
  };
}

export function encodeImageData(imageData, message) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error('Escribe un mensaje antes de codificar.');
  }

  const msgBytes = encoder.encode(message);
  const stats = analyzeImageData(imageData);

  if (msgBytes.length > stats.maxMessageBytes) {
    throw new Error(
      `El mensaje ocupa ${msgBytes.length} bytes, pero esta imagen solo admite ${stats.maxMessageBytes} bytes.`
    );
  }

  const payload = new Uint8Array(HEADER_BYTES + msgBytes.length);
  payload.set(MAGIC, 0);
  new DataView(payload.buffer).setUint32(4, msgBytes.length, false);
  payload.set(msgBytes, HEADER_BYTES);

  const out = new Uint8ClampedArray(imageData.data);
  const totalBits = payload.length * 8;
  let bitPos = 0;

  for (let i = 0; i < out.length && bitPos < totalBits; i += 4) {
    if (out[i + 3] !== 255) continue;

    for (let c = 0; c < 3 && bitPos < totalBits; c++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitShift = 7 - (bitPos % 8);
      const bit = (payload[byteIdx] >> bitShift) & 1;
      out[i + c] = (out[i + c] & 0xfe) | bit;
      bitPos++;
    }
  }

  return {
    data: out,
    width: imageData.width,
    height: imageData.height,
    messageBytes: msgBytes.length,
    usedBits: totalBits,
    ...stats
  };
}

// Cursor continuo sobre R/G/B de pixeles opacos para no perder alineacion tras la cabecera (64 % 3 === 1).
function createBitReader(data) {
  let p = 0;
  let c = 0;
  const len = data.length;

  function readBit() {
    while (p < len) {
      if (data[p + 3] === 255) {
        const bit = data[p + c] & 1;
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

export function decodeImageData(imageData) {
  const stats = analyzeImageData(imageData);
  const reader = createBitReader(imageData.data);
  const header = reader.readBytes(HEADER_BYTES);

  if (!header || MAGIC.some((byte, idx) => header[idx] !== byte)) {
    throw new Error(
      'No se encontró ningún mensaje oculto en esta imagen. Verifica que sea el PNG original sin compresión.'
    );
  }

  const msgLen = new DataView(header.buffer).getUint32(4, false);
  const totalBits = (HEADER_BYTES + msgLen) * 8;

  if (msgLen === 0 || totalBits > stats.usableBits) {
    throw new Error(
      'La cabecera del mensaje está dañada o la longitud declarada excede la capacidad de la imagen.'
    );
  }

  const msgBytes = reader.readBytes(msgLen);
  if (!msgBytes) {
    throw new Error('Los bits del mensaje están incompletos o la imagen fue recortada.');
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
    messageBytes: msgLen,
    usedBits: totalBits,
    ...stats
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

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

    const ctx = canvas.getContext('2d');
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

export function selfCheck() {
  const width = 16;
  const height = 16;
  const totalPixels = width * height;
  const raw = new Uint8ClampedArray(totalPixels * 4);

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    raw[i] = (p * 17) % 256;
    raw[i + 1] = (p * 43) % 256;
    raw[i + 2] = (p * 71) % 256;
    // Mezcla de pixeles transparentes (A=0), semitransparentes (A=128) y opacos (A=255).
    raw[i + 3] = p % 5 === 0 ? 0 : p % 5 === 1 ? 128 : 255;
  }

  const fakeImg = { width, height, data: raw };
  const sample = 'Hola mundo! Ñandú 🔐🚀\nLínea 2';
  const encoded = encodeImageData(fakeImg, sample);
  const decoded = decodeImageData({ width, height, data: encoded.data });

  assert(decoded.message === sample, 'el texto decodificado debe coincidir exactamente');

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    assert(encoded.data[i + 3] === raw[i + 3], 'el canal alpha no debe cambiar');
    if (raw[i + 3] !== 255) {
      for (let c = 0; c < 4; c++) {
        assert(encoded.data[i + c] === raw[i + c], 'pixeles no opacos deben quedar intactos');
      }
    } else {
      for (let c = 0; c < 3; c++) {
        assert(Math.abs(encoded.data[i + c] - raw[i + c]) <= 1, 'RGB opaco cambia como máximo 1');
      }
    }
  }

  assertThrows(() => encodeImageData(fakeImg, ''), 'mensaje vacío debe lanzar error');
  assertThrows(
    () => encodeImageData(fakeImg, 'A'.repeat(encoded.maxMessageBytes + 1)),
    'mensaje mayor a la capacidad debe lanzar error'
  );
  assertThrows(() => decodeImageData(fakeImg), 'imagen sin cabecera debe lanzar error');

  const corrupted = new Uint8ClampedArray(encoded.data);
  const firstOpaque = corrupted.findIndex((_, idx) => idx % 4 === 3 && corrupted[idx] === 255) - 3;
  corrupted[firstOpaque] ^= 1;
  assertThrows(
    () => decodeImageData({ width, height, data: corrupted }),
    'cabecera alterada debe lanzar error'
  );

  return true;
}

globalThis.Stego = {
  MAGIC,
  HEADER_BYTES,
  utf8ByteLength,
  analyzeImageData,
  encodeImageData,
  decodeImageData,
  loadImageFile,
  imageDataToPngBlob,
  selfCheck
};
