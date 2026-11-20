// Inspector visual "Rayos X" para planos de bits (0..7) y mapa de diferencias con max-pooling.
export const DEFAULT_MAX_DIM = 960;

const EXCLUDED_BITPLANE_RGBA = [36, 48, 66, 255];
const EXCLUDED_HEATMAP_RGBA = [24, 32, 44, 255];

export function computeTargetDims(width, height, maxDim = DEFAULT_MAX_DIM) {
  if (!width || !height || width <= 0 || height <= 0) {
    return { outW: 0, outH: 0 };
  }

  const limit = Math.max(1, Math.floor(maxDim || DEFAULT_MAX_DIM));
  if (width <= limit && height <= limit) {
    return { outW: width, outH: height };
  }

  const scale = limit / Math.max(width, height);
  const outW = Math.max(1, Math.min(limit, Math.round(width * scale)));
  const outH = Math.max(1, Math.min(limit, Math.round(height * scale)));
  return { outW, outH };
}

function writeBufferToCanvas(canvas, outBuf, outW, outH) {
  if (!canvas) return;
  canvas.width = outW;
  canvas.height = outH;
  if (typeof canvas.getContext !== 'function') return;

  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) || canvas.getContext('2d');
  if (!ctx || typeof ctx.putImageData !== 'function') return;

  const frame =
    typeof globalThis.ImageData === 'function'
      ? new globalThis.ImageData(outBuf, outW, outH)
      : { data: outBuf, width: outW, height: outH };
  ctx.putImageData(frame, 0, 0);
}

export function renderBitPlane(
  canvas,
  imageData,
  { channel = 'rgb', plane = 0, maxDim = DEFAULT_MAX_DIM, zoom1x1 = false } = {}
) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    throw new Error('Se requiere un ImageData válido para renderizar el plano de bits.');
  }

  const { data: src, width, height } = imageData;
  const bitPlane = Math.max(0, Math.min(7, Math.trunc(Number(plane) || 0)));
  const bitMask = 1 << bitPlane;

  const rawCh = typeof channel === 'string' ? channel.toLowerCase() : 'rgb';
  const normalizedChannel = rawCh === 'r' || rawCh === 'g' || rawCh === 'b' ? rawCh : 'rgb';
  const chOffset = normalizedChannel === 'r' ? 0 : normalizedChannel === 'g' ? 1 : 2;

  const limit = Math.max(1, Math.floor(maxDim || DEFAULT_MAX_DIM));
  let outW;
  let outH;
  if (zoom1x1) {
    outW = Math.min(width, limit);
    outH = Math.min(height, limit);
  } else {
    ({ outW, outH } = computeTargetDims(width, height, limit));
  }

  const out = new Uint8ClampedArray(outW * outH * 4);
  let opaquePixels = 0;
  let skippedPixels = 0;

  // Mapear coordenadas fuente una sola vez por eje para evitar divisiones en el bucle interno.
  const xMap = new Uint32Array(outW);
  const yMap = new Uint32Array(outH);
  for (let dx = 0; dx < outW; dx++) {
    xMap[dx] = zoom1x1 || outW === width ? dx : Math.min(width - 1, Math.floor((dx * width) / outW));
  }
  for (let dy = 0; dy < outH; dy++) {
    yMap[dy] =
      zoom1x1 || outH === height ? dy : Math.min(height - 1, Math.floor((dy * height) / outH));
  }

  for (let dy = 0; dy < outH; dy++) {
    const srcRowBase = yMap[dy] * width;
    const dstRowBase = dy * outW;

    for (let dx = 0; dx < outW; dx++) {
      const si = (srcRowBase + xMap[dx]) * 4;
      const di = (dstRowBase + dx) * 4;

      if (src[si + 3] !== 255) {
        skippedPixels++;
        out[di] = EXCLUDED_BITPLANE_RGBA[0];
        out[di + 1] = EXCLUDED_BITPLANE_RGBA[1];
        out[di + 2] = EXCLUDED_BITPLANE_RGBA[2];
        out[di + 3] = EXCLUDED_BITPLANE_RGBA[3];
        continue;
      }

      opaquePixels++;
      if (normalizedChannel === 'rgb') {
        out[di] = src[si] & bitMask ? 255 : 0;
        out[di + 1] = src[si + 1] & bitMask ? 255 : 0;
        out[di + 2] = src[si + 2] & bitMask ? 255 : 0;
        out[di + 3] = 255;
      } else {
        const val = src[si + chOffset] & bitMask ? 255 : 0;
        out[di] = val;
        out[di + 1] = val;
        out[di + 2] = val;
        out[di + 3] = 255;
      }
    }
  }

  writeBufferToCanvas(canvas, out, outW, outH);

  return {
    width: outW,
    height: outH,
    plane: bitPlane,
    channel: normalizedChannel,
    zoom1x1: Boolean(zoom1x1),
    opaquePixels,
    skippedPixels
  };
}

export const renderLsbPlane = renderBitPlane;

export function renderDiffHeatmap(
  canvas,
  origImageData,
  encImageData,
  { maxDim = DEFAULT_MAX_DIM } = {}
) {
  if (
    !origImageData ||
    !encImageData ||
    !origImageData.data ||
    !encImageData.data ||
    origImageData.width !== encImageData.width ||
    origImageData.height !== encImageData.height ||
    origImageData.data.length !== encImageData.data.length
  ) {
    throw new Error('Las imágenes original y codificada deben tener las mismas dimensiones.');
  }

  const { data: orig, width, height } = origImageData;
  const enc = encImageData.data;
  const { outW, outH } = computeTargetDims(width, height, maxDim);

  // Max-pooling por bloque sobre resolución completa → 100% recall aunque solo cambie 1 píxel.
  const maxBlockDelta = new Uint8Array(outW * outH);
  const srcToDstX = new Uint16Array(width);
  const srcToDstY = new Uint16Array(height);
  for (let x = 0; x < width; x++) {
    srcToDstX[x] = outW === width ? x : Math.min(outW - 1, Math.floor((x * outW) / width));
  }
  for (let y = 0; y < height; y++) {
    srcToDstY[y] = outH === height ? y : Math.min(outH - 1, Math.floor((y * outH) / height));
  }

  let changedPixels = 0;
  let opaquePixels = 0;
  let maxDelta = 0;

  for (let y = 0; y < height; y++) {
    const srcRowOffset = y * width * 4;
    const dstRowBase = srcToDstY[y] * outW;

    for (let x = 0; x < width; x++) {
      const i = srcRowOffset + x * 4;
      if (orig[i + 3] !== 255) continue;
      opaquePixels++;

      const r0 = orig[i];
      const g0 = orig[i + 1];
      const b0 = orig[i + 2];
      const r1 = enc[i];
      const g1 = enc[i + 1];
      const b1 = enc[i + 2];

      if (r0 !== r1 || g0 !== g1 || b0 !== b1) {
        const dr = r0 > r1 ? r0 - r1 : r1 - r0;
        const dg = g0 > g1 ? g0 - g1 : g1 - g0;
        const db = b0 > b1 ? b0 - b1 : b1 - b0;
        const delta = dr >= dg ? (dr >= db ? dr : db) : dg >= db ? dg : db;

        changedPixels++;
        if (delta > maxDelta) maxDelta = delta;

        const bIdx = dstRowBase + srcToDstX[x];
        if (delta > maxBlockDelta[bIdx]) {
          maxBlockDelta[bIdx] = delta;
        }
      }
    }
  }

  const out = new Uint8ClampedArray(outW * outH * 4);
  const dstToSrcX = new Uint32Array(outW);
  const dstToSrcY = new Uint32Array(outH);
  for (let dx = 0; dx < outW; dx++) {
    dstToSrcX[dx] = outW === width ? dx : Math.min(width - 1, Math.floor((dx * width) / outW));
  }
  for (let dy = 0; dy < outH; dy++) {
    dstToSrcY[dy] = outH === height ? dy : Math.min(height - 1, Math.floor((dy * height) / outH));
  }

  let litBuckets = 0;

  for (let dy = 0; dy < outH; dy++) {
    const srcRowBase = dstToSrcY[dy] * width;
    const dstRowBase = dy * outW;

    for (let dx = 0; dx < outW; dx++) {
      const bIdx = dstRowBase + dx;
      const di = bIdx * 4;
      const delta = maxBlockDelta[bIdx];

      if (delta === 0) {
        const si = (srcRowBase + dstToSrcX[dx]) * 4;
        if (orig[si + 3] !== 255) {
          out[di] = EXCLUDED_HEATMAP_RGBA[0];
          out[di + 1] = EXCLUDED_HEATMAP_RGBA[1];
          out[di + 2] = EXCLUDED_HEATMAP_RGBA[2];
          out[di + 3] = EXCLUDED_HEATMAP_RGBA[3];
        } else {
          const luma = Math.round(
            (0.299 * orig[si] + 0.587 * orig[si + 1] + 0.114 * orig[si + 2]) * 0.25
          );
          out[di] = luma;
          out[di + 1] = luma;
          out[di + 2] = luma;
          out[di + 3] = 255;
        }
      } else {
        litBuckets++;
        if (delta === 1) {
          // Plano 0 (LSB ±1): magenta vivo.
          out[di] = 255;
          out[di + 1] = 0;
          out[di + 2] = 212;
          out[di + 3] = 255;
        } else if (delta <= 3) {
          // Plano 1 (Δ 2..3): amarillo intenso.
          out[di] = 255;
          out[di + 1] = 214;
          out[di + 2] = 10;
          out[di + 3] = 255;
        } else if (delta <= 15) {
          // Planos 2..3 (Δ 4..15): naranja vivo.
          out[di] = 255;
          out[di + 1] = 122;
          out[di + 2] = 0;
          out[di + 3] = 255;
        } else {
          // Planos 4..7 (Δ >= 16): rojo intenso.
          out[di] = 255;
          out[di + 1] = 36;
          out[di + 2] = 48;
          out[di + 3] = 255;
        }
      }
    }
  }

  writeBufferToCanvas(canvas, out, outW, outH);

  const changedPercent = opaquePixels > 0 ? (changedPixels / opaquePixels) * 100 : 0;

  return {
    width: outW,
    height: outH,
    changedPixels,
    opaquePixels,
    changedPercent,
    maxDelta,
    litBuckets
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`inspectorSelfCheck falló: ${message}`);
  }
}

function createMockCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    lastImageData: null,
    getContext() {
      return {
        putImageData(imgData) {
          canvas.lastImageData = imgData;
        }
      };
    }
  };
  return canvas;
}

export function inspectorSelfCheck() {
  assert(renderLsbPlane === renderBitPlane, 'renderLsbPlane debe ser alias de renderBitPlane');

  // 1. computeTargetDims (sin upscale, preservando proporción y tope <= maxDim).
  const dSmall = computeTargetDims(256, 256, 960);
  assert(dSmall.outW === 256 && dSmall.outH === 256, 'no debe hacer upscale');
  const dFullHd = computeTargetDims(1920, 1080, 960);
  assert(dFullHd.outW === 960 && dFullHd.outH === 540, '1920×1080 → 960×540');
  const dPortrait = computeTargetDims(1500, 3000, 960);
  assert(dPortrait.outW === 480 && dPortrait.outH === 960, '1500×3000 → 480×960');
  const dThin = computeTargetDims(4000, 2, 960);
  assert(dThin.outW === 960 && dThin.outH === 1, 'proporción extrema nunca da altura 0');

  // 2. renderBitPlane (incluyendo píxeles A < 255, canal monocromo, plano alto y zoom1x1).
  const mockBp = createMockCanvas();
  const sampleData = new Uint8ClampedArray([
    0b00000001, 0b00000010, 0b10000000, 255, // px 0 (opaco)
    0b00000000, 0b11111111, 0b00000001, 255, // px 1 (opaco)
    255, 255, 255, 0, // px 2 (transparente)
    255, 255, 255, 128 // px 3 (semitransparente)
  ]);
  const sampleImg = { width: 4, height: 1, data: sampleData };

  const bpRgb = renderBitPlane(mockBp, sampleImg, { channel: 'rgb', plane: 0 });
  assert(
    bpRgb.width === 4 && bpRgb.height === 1 && bpRgb.opaquePixels === 2 && bpRgb.skippedPixels === 2,
    'renderBitPlane debe distinguir opacos y excluidos'
  );
  const outRgb = mockBp.lastImageData.data;
  assert(outRgb[0] === 255 && outRgb[1] === 0 && outRgb[2] === 0, 'px 0 plano 0 RGB=[255,0,0]');
  assert(outRgb[4] === 0 && outRgb[5] === 255 && outRgb[6] === 255, 'px 1 plano 0 RGB=[0,255,255]');
  assert(
    outRgb[8] === EXCLUDED_BITPLANE_RGBA[0] &&
      outRgb[9] === EXCLUDED_BITPLANE_RGBA[1] &&
      outRgb[10] === EXCLUDED_BITPLANE_RGBA[2],
    'px A=0 debe pintarse con color de exclusión'
  );
  assert(
    outRgb[12] === EXCLUDED_BITPLANE_RGBA[0] &&
      outRgb[13] === EXCLUDED_BITPLANE_RGBA[1] &&
      outRgb[14] === EXCLUDED_BITPLANE_RGBA[2],
    'px A=128 debe pintarse con color de exclusión'
  );

  const bpPlane7B = renderBitPlane(mockBp, sampleImg, { channel: 'b', plane: 7 });
  assert(bpPlane7B.plane === 7 && bpPlane7B.channel === 'b', 'debe retornar plano y canal normalizados');
  const outB7 = mockBp.lastImageData.data;
  assert(outB7[0] === 255 && outB7[1] === 255 && outB7[2] === 255, 'px 0 bit 7 canal B=255');
  assert(outB7[4] === 0 && outB7[5] === 0 && outB7[6] === 0, 'px 1 bit 7 canal B=0');

  // Zoom 1:1 recorta esquina superior izquierda sin reescalar.
  const wideBuf = new Uint8ClampedArray(1200 * 4 * 4);
  for (let i = 3; i < wideBuf.length; i += 4) wideBuf[i] = 255;
  const bpZoom = renderBitPlane(mockBp, { width: 1200, height: 4, data: wideBuf }, {
    maxDim: 960,
    zoom1x1: true
  });
  assert(bpZoom.width === 960 && bpZoom.height === 4 && bpZoom.zoom1x1, 'zoom1x1 recorta a 960×4');

  // 3. renderDiffHeatmap en 1920×1080 reducido a maxDim=960 con exactamente 1 píxel alterado (delta=1).
  const hdW = 1920;
  const hdH = 1080;
  const hdOrig = new Uint8ClampedArray(hdW * hdH * 4);
  for (let i = 0; i < hdOrig.length; i += 4) {
    hdOrig[i] = 120;
    hdOrig[i + 1] = 120;
    hdOrig[i + 2] = 120;
    hdOrig[i + 3] = 255;
  }
  const hdEnc = new Uint8ClampedArray(hdOrig);
  // Coordenadas impares (1337, 777) que un muestreo nearest-neighbor 2× perdería.
  const targetX = 1337;
  const targetY = 777;
  const targetIdx = (targetY * hdW + targetX) * 4;
  hdEnc[targetIdx] = 121; // delta = 1

  const mockHm = createMockCanvas();
  const hm1 = renderDiffHeatmap(
    mockHm,
    { width: hdW, height: hdH, data: hdOrig },
    { width: hdW, height: hdH, data: hdEnc },
    { maxDim: 960 }
  );
  assert(hm1.width === 960 && hm1.height === 540, 'heatmap 1920×1080 debe reducirse a 960×540');
  assert(hm1.changedPixels === 1, 'changedPixels debe ser exactamente 1');
  assert(hm1.opaquePixels === hdW * hdH, 'opaquePixels debe ser 1920×1080');
  assert(hm1.maxDelta === 1, 'maxDelta debe ser 1');
  assert(hm1.litBuckets === 1, 'litBuckets debe ser exactamente 1 (100% recall)');

  const bx = Math.floor((targetX * 960) / hdW);
  const by = Math.floor((targetY * 540) / hdH);
  const bi = (by * 960 + bx) * 4;
  const hmOut = mockHm.lastImageData.data;
  assert(
    hmOut[bi] === 255 && hmOut[bi + 1] === 0 && hmOut[bi + 2] === 212,
    'bucket con delta=1 debe pintarse en magenta vivo'
  );
  assert(hmOut[0] === 30 && hmOut[1] === 30 && hmOut[2] === 30, 'fondo sin cambio debe ser gris atenuado');

  // Segundo píxel con delta alto (>15) debe escalar a rojo intenso.
  const hiIdx = (10 * hdW + 10) * 4;
  hdEnc[hiIdx + 1] = 152; // delta = 32
  const hm2 = renderDiffHeatmap(
    mockHm,
    { width: hdW, height: hdH, data: hdOrig },
    { width: hdW, height: hdH, data: hdEnc },
    { maxDim: 960 }
  );
  assert(hm2.changedPixels === 2 && hm2.litBuckets === 2 && hm2.maxDelta === 32, 'segundo píxel delta=32');
  const hiBi = (Math.floor((10 * 540) / hdH) * 960 + Math.floor((10 * 960) / hdW)) * 4;
  const hmOut2 = mockHm.lastImageData.data;
  assert(
    hmOut2[hiBi] === 255 && hmOut2[hiBi + 1] === 36 && hmOut2[hiBi + 2] === 48,
    'bucket con delta>15 debe pintarse en rojo intenso'
  );

  return true;
}

globalThis.LsbInspector = {
  DEFAULT_MAX_DIM,
  computeTargetDims,
  renderBitPlane,
  renderLsbPlane,
  renderDiffHeatmap,
  inspectorSelfCheck
};
