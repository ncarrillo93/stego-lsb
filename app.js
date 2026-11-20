// Composition API de Vue 3: ref()/shallowRef(), computed(), watch(), template refs y ciclo de vida.
import {
  createApp,
  ref,
  shallowRef,
  computed,
  watch,
  nextTick,
  onMounted,
  onUnmounted
} from './vendor/vue.esm-browser.prod.js';
import * as Stego from './stego.js';

const THEME_STORAGE_KEY = 'stego-theme';
const MAX_RESIZE_DIM = 1600;
const HEADER_OPAQUE_PIXELS_ENCRYPTED = (Stego.HEADER_BYTES_V2_ENCRYPTED * 8) / 3; // 104 px
const utf8Encoder = new TextEncoder();

function readInitialTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === 'light' || value === 'dark') {
      return value;
    }
  } catch {
    // Almacenamiento no disponible o restringido.
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

function extractPastedImageFile(event) {
  const dt = event.clipboardData;
  if (!dt) return null;

  if (dt.items && dt.items.length > 0) {
    for (const item of dt.items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }

  if (dt.files && dt.files.length > 0) {
    for (const file of dt.files) {
      if (file.type && file.type.startsWith('image/')) {
        return file;
      }
    }
  }

  return null;
}

// Genera ASCII imprimible de alta entropía (94 símbolos: 0x21..0x7E) para simular exceso aun con deflate-raw.
function generateHighEntropyAscii(length) {
  if (length <= 0) return '';
  const alphabetSize = 94;
  const out = new Array(length);
  const rand = new Uint8Array(Math.min(4096, length));
  let pos = 0;

  while (pos < length) {
    const chunkLen = Math.min(rand.length, length - pos);
    const slice = chunkLen === rand.length ? rand : rand.subarray(0, chunkLen);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(slice);
    } else {
      for (let i = 0; i < chunkLen; i++) {
        slice[i] = (Math.random() * 256) | 0;
      }
    }
    for (let i = 0; i < chunkLen; i++) {
      out[pos++] = String.fromCharCode(33 + (slice[i] % alphabetSize));
    }
  }

  return out.join('');
}

// Genera una imagen de ejemplo 256×256 al vuelo (0 KB en repo) con degradado, formas nítidas y esquina A=0.
function createSampleImageFile() {
  return new Promise((resolve, reject) => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) {
      reject(new Error('No se pudo generar la imagen de ejemplo en el lienzo.'));
      return;
    }

    // Fondo con degradado suave para evidenciar fácilmente la degradación por planos de bits.
    const bg = ctx.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, '#1e3a8a');
    bg.addColorStop(0.5, '#0d9488');
    bg.addColorStop(1, '#f59e0b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // Formas geométricas nítidas y barras de color para evaluar bordes y posterización.
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(84, 108, 48, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(84, 108, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e11d48';
    ctx.fillRect(142, 76, 86, 56);

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(142, 132);
    ctx.lineTo(185, 76);
    ctx.lineTo(228, 132);
    ctx.closePath();
    ctx.fill();

    const palette = ['#ef4444', '#22c55e', '#3b82f6', '#eab308', '#f8fafc', '#111827'];
    const barW = Math.floor(216 / palette.length);
    for (let i = 0; i < palette.length; i++) {
      ctx.fillStyle = palette[i];
      ctx.fillRect(20 + i * barW, 166, barW, 20);
    }

    // Etiqueta legible "Stego LSB".
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(20, 200, 216, 36);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 20px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Stego LSB', 128, 219);

    // Esquina superior derecha 48×48 completamente transparente (A=0) para demostrar preservación alfa.
    ctx.clearRect(size - 48, 0, 48, 48);

    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('No se pudo exportar la imagen de ejemplo PNG.'));
        return;
      }
      resolve(new File([blob], 'ejemplo-stego.png', { type: 'image/png' }));
    }, 'image/png');
  });
}

// Redimensiona una imagen en <canvas> preservando proporción exacta y transparencia (A=0).
function loadResizedImageFile(file, maxDim) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('Selecciona un archivo de imagen válido.'));
      return;
    }

    const tempUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(tempUrl);
      try {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;
        if (srcW === 0 || srcH === 0) {
          throw new Error('No se pudo leer la imagen en el lienzo del navegador.');
        }

        const scale = maxDim / Math.max(srcW, srcH);
        const targetW = Math.max(1, Math.round(srcW * scale));
        const targetH = Math.max(1, Math.round(srcH * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;

        const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
        if (!ctx) {
          throw new Error('No se pudo inicializar el lienzo para redimensionar la imagen.');
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const imageData = ctx.getImageData(0, 0, targetW, targetH);
        const stats = Stego.analyzeImageData(imageData);

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('No se pudo generar la vista previa redimensionada.'));
            return;
          }
          const previewUrl = URL.createObjectURL(blob);
          resolve({
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            isResized: true,
            previewUrl,
            imageData,
            ...stats
          });
        }, 'image/png');
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Error al redimensionar la imagen.'));
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(tempUrl);
      reject(new Error('No se pudo cargar el archivo de imagen para redimensionarlo.'));
    };

    img.src = tempUrl;
  });
}

createApp({
  setup() {
    const activeTab = ref('encode');
    const cryptoSupported = Stego.isCryptoSupported();
    const compressionSupported = Stego.isCompressionSupported();

    // Tema visual Bootstrap 5.3 ('light' | 'dark')
    const theme = ref(readInitialTheme());
    const isDark = computed(() => theme.value === 'dark');

    function applyTheme(mode) {
      document.documentElement.setAttribute('data-bs-theme', mode);
    }

    function toggleTheme() {
      theme.value = isDark.value ? 'light' : 'dark';
    }

    applyTheme(theme.value);

    watch(theme, (nextTheme) => {
      applyTheme(nextTheme);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {
        // Ignorar si localStorage está bloqueado.
      }
    });

    // Estado de codificación ("Ocultar mensaje")
    const encodeFileInput = ref(null);
    const encodeSourceFile = shallowRef(null);
    const encodeOriginalDims = shallowRef(null);
    const resizeBeforeEncode = ref(false);
    const isResizingImage = ref(false);
    const encodeImg = shallowRef(null);
    const message = ref('');
    const encodePassword = ref('');
    const showEncodePassword = ref(false);
    const useCompression = ref(compressionSupported);
    const useScatter = ref(true);
    const encodeError = ref('');
    const encodeResult = shallowRef(null);
    const isEncoding = ref(false);
    const isDraggingEncode = ref(false);
    let encodeDragDepth = 0;
    let encodeLoadSeq = 0;

    // Estimación asíncrona con debounce de compresión deflate-raw
    const estimatedCompressedBytes = ref(null);
    const isEstimatingCompression = ref(false);
    let compressionTimer = null;
    let compressionReqSeq = 0;

    // Vista previa en vivo de degradación progresiva (<canvas>) + comparador Antes/Después
    const livePreviewCanvas = ref(null);
    const livePsnrDb = ref(null);
    const splitPercent = ref(50);
    const hasLivePreview = ref(false);
    const livePreviewStale = ref(false);
    const isRenderingPreview = ref(false);
    let previewTimer = null;
    let lastPreviewFrame = null;

    // Estado de decodificación ("Leer mensaje")
    const decodeFileInput = ref(null);
    const decodeImg = shallowRef(null);
    const decodeMeta = shallowRef(null);
    const decodePassword = ref('');
    const showDecodePassword = ref(false);
    const isDecoding = ref(false);
    const decodeFromPaste = ref(false);
    const decoded = shallowRef(null);
    const decodeError = ref('');
    const isDraggingDecode = ref(false);
    let decodeDragDepth = 0;
    const copied = ref(false);
    let copyTimer = null;

    const isEncryptedEncode = computed(() => encodePassword.value.length > 0);
    const isScatteredEncode = computed(() => isEncryptedEncode.value && useScatter.value);
    const isCompressedActive = computed(() => useCompression.value && compressionSupported);

    const canResizeEncode = computed(
      () =>
        Boolean(encodeOriginalDims.value) &&
        (encodeOriginalDims.value.width > MAX_RESIZE_DIM ||
          encodeOriginalDims.value.height > MAX_RESIZE_DIM)
    );

    const messageBytes = computed(() => Stego.utf8ByteLength(message.value));

    const capacityBudget = computed(() => {
      const options = {
        encrypted: isEncryptedEncode.value,
        scattered: isScatteredEncode.value
      };
      if (!encodeImg.value) {
        return {
          losslessBytes: 0,
          maxTotalBytes: 0,
          overheadBytes: Stego.getOverheadBytes(options)
        };
      }
      return Stego.getCapacityBytes(encodeImg.value, options);
    });

    const effectivePayloadBytes = computed(() => {
      if (messageBytes.value === 0) return 0;
      if (isCompressedActive.value && estimatedCompressedBytes.value !== null) {
        return estimatedCompressedBytes.value;
      }
      return messageBytes.value;
    });

    const compressionWillSave = computed(
      () =>
        isCompressedActive.value &&
        estimatedCompressedBytes.value !== null &&
        estimatedCompressedBytes.value < messageBytes.value
    );

    const usedBitsPreview = computed(() => {
      if (effectivePayloadBytes.value <= 0) return 0;
      return (capacityBudget.value.overheadBytes + effectivePayloadBytes.value) * 8;
    });

    const qualityInfo = computed(() => {
      const opaque = encodeImg.value?.opaquePixels || 0;
      if (effectivePayloadBytes.value <= 0 || opaque === 0) {
        return Stego.estimateQuality(0, opaque);
      }

      if (isScatteredEncode.value) {
        const remainingOpaque = Math.max(0, opaque - HEADER_OPAQUE_PIXELS_ENCRYPTED);
        const bodyBits = (effectivePayloadBytes.value + Stego.GCM_TAG_BYTES) * 8;
        const bodyBitsPerPlane = remainingOpaque * 3;
        const base = Stego.estimateQuality(usedBitsPreview.value, opaque);

        if (bodyBitsPerPlane <= 0 || bodyBits <= bodyBitsPerPlane) {
          return base;
        }

        const actualPlanes = Math.min(8, Math.ceil(bodyBits / bodyBitsPerPlane));
        const bitsInActive =
          bodyBits >= bodyBitsPerPlane * 8
            ? bodyBitsPerPlane
            : ((bodyBits - 1) % bodyBitsPerPlane) + 1;
        const adjusted = Stego.estimateQuality((actualPlanes - 1) * (opaque * 3) + 1, opaque);

        return {
          ...adjusted,
          activePlaneFill: (bitsInActive / bodyBitsPerPlane) * 100,
          overallPercent: base.overallPercent,
          losslessPercent: base.losslessPercent
        };
      }

      return Stego.estimateQuality(usedBitsPreview.value, opaque);
    });

    const isOverCapacity = computed(() => {
      if (!encodeImg.value || messageBytes.value === 0) return false;
      // Mientras corre la estimación con debounce de deflate-raw, evitar falsos bloqueos por tamaño crudo.
      if (
        isCompressedActive.value &&
        isEstimatingCompression.value &&
        messageBytes.value > capacityBudget.value.maxTotalBytes
      ) {
        return false;
      }
      return effectivePayloadBytes.value > capacityBudget.value.maxTotalBytes;
    });

    const isDegrading = computed(
      () =>
        Boolean(encodeImg.value) &&
        !isOverCapacity.value &&
        !(
          isCompressedActive.value &&
          isEstimatingCompression.value &&
          messageBytes.value > capacityBudget.value.losslessBytes
        ) &&
        qualityInfo.value.planesUsed > 1
    );

    const isLargeImage = computed(
      () => Boolean(encodeImg.value) && encodeImg.value.totalPixels > Stego.WARN_PIXELS
    );

    const showingDegradedCanvas = computed(() => isDegrading.value && hasLivePreview.value);

    const canEncode = computed(
      () =>
        Boolean(encodeImg.value) &&
        capacityBudget.value.maxTotalBytes > 0 &&
        messageBytes.value > 0 &&
        !isOverCapacity.value &&
        !isEncoding.value &&
        !isResizingImage.value &&
        !(isEncryptedEncode.value && !cryptoSupported)
    );

    const canSimulateNextPlane = computed(
      () =>
        Boolean(encodeImg.value) &&
        capacityBudget.value.maxTotalBytes > 0 &&
        !isOverCapacity.value &&
        !isResizingImage.value &&
        qualityInfo.value.planesUsed < 8
    );

    const progressPercent = computed(() => {
      if (!encodeImg.value || messageBytes.value === 0) return 0;
      if (isOverCapacity.value) return 100;
      if (isDegrading.value) return Math.min(100, qualityInfo.value.overallPercent);
      return Math.min(100, qualityInfo.value.losslessPercent);
    });

    const progressBarClass = computed(() => {
      if (isOverCapacity.value) return 'bg-danger';
      switch (qualityInfo.value.level) {
        case 'lossless':
          return 'bg-success';
        case 'high':
          return 'bg-info';
        case 'visible':
          return 'bg-warning';
        case 'heavy':
          return 'bg-danger';
        case 'destroyed':
          return 'bg-dark';
        default:
          return 'bg-secondary';
      }
    });

    const qualityBadgeClass = computed(() =>
      isOverCapacity.value ? 'text-bg-danger' : qualityInfo.value.badgeClass
    );

    const qualityBadgeLabel = computed(() =>
      isOverCapacity.value ? 'Supera el máximo (8 planos)' : qualityInfo.value.label
    );

    const needsDecodePassword = computed(
      () => Boolean(decodeMeta.value?.encrypted) && !decoded.value
    );

    function clearEncodeResult() {
      if (encodeResult.value?.downloadUrl) {
        URL.revokeObjectURL(encodeResult.value.downloadUrl);
      }
      encodeResult.value = null;
    }

    function resetLivePreview() {
      clearTimeout(previewTimer);
      previewTimer = null;
      lastPreviewFrame = null;
      hasLivePreview.value = false;
      livePreviewStale.value = false;
      livePsnrDb.value = null;
    }

    function revokeEncodeUrls() {
      if (encodeImg.value?.previewUrl) {
        URL.revokeObjectURL(encodeImg.value.previewUrl);
      }
      clearEncodeResult();
    }

    function clearEncode() {
      encodeLoadSeq += 1;
      revokeEncodeUrls();
      resetLivePreview();
      encodeSourceFile.value = null;
      encodeOriginalDims.value = null;
      resizeBeforeEncode.value = false;
      isResizingImage.value = false;
      splitPercent.value = 50;
      encodeImg.value = null;
      encodeError.value = '';
      if (encodeFileInput.value) {
        encodeFileInput.value.value = '';
      }
    }

    function clearDecode() {
      if (decodeImg.value?.previewUrl) {
        URL.revokeObjectURL(decodeImg.value.previewUrl);
      }
      clearTimeout(copyTimer);
      copyTimer = null;
      decodeImg.value = null;
      decodeMeta.value = null;
      decodePassword.value = '';
      showDecodePassword.value = false;
      isDecoding.value = false;
      decodeFromPaste.value = false;
      decoded.value = null;
      decodeError.value = '';
      copied.value = false;
      if (decodeFileInput.value) {
        decodeFileInput.value.value = '';
      }
    }

    function waitForPaint() {
      return new Promise((resolve) => {
        const fallback = setTimeout(resolve, 50);
        requestAnimationFrame(() => {
          clearTimeout(fallback);
          resolve();
        });
      });
    }

    function paintFrameToCanvas(frame) {
      const canvas = livePreviewCanvas.value;
      if (!canvas || !frame) return;
      canvas.width = frame.width;
      canvas.height = frame.height;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!ctx) return;
      ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    }

    function buildPreviewMessageForFastRender() {
      // Sin cifrado ni ahorro de compresión, renderizamos el mensaje exacto solo si cabe en encodeImageData.
      if (
        !isEncryptedEncode.value &&
        !compressionWillSave.value &&
        messageBytes.value <= encodeImg.value.maxTotalBytes
      ) {
        return message.value;
      }

      // Con contraseña o compresión, estimamos la degradación sin ejecutar PBKDF2 en cada tecla.
      const extraOverhead =
        capacityBudget.value.overheadBytes - Stego.getOverheadBytes({ encrypted: false });
      const targetLen = Math.min(
        encodeImg.value.maxTotalBytes,
        Math.max(1, effectivePayloadBytes.value + Math.max(0, extraOverhead))
      );
      const seed =
        'Stego LSB preview estimado [0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz]. ';
      return seed.repeat(Math.ceil(targetLen / seed.length)).slice(0, targetLen);
    }

    async function renderDegradedPreview() {
      if (isEstimatingCompression.value) {
        return;
      }

      if (
        !encodeImg.value ||
        !isDegrading.value ||
        effectivePayloadBytes.value > capacityBudget.value.maxTotalBytes
      ) {
        resetLivePreview();
        return;
      }

      isRenderingPreview.value = true;
      try {
        await nextTick();
        if (isLargeImage.value) {
          await waitForPaint();
        }

        if (
          isEstimatingCompression.value ||
          !encodeImg.value ||
          !isDegrading.value ||
          effectivePayloadBytes.value > capacityBudget.value.maxTotalBytes
        ) {
          if (!isEstimatingCompression.value) {
            resetLivePreview();
          }
          return;
        }

        const previewMessage = buildPreviewMessageForFastRender();
        const encoded = Stego.encodeImageData(encodeImg.value.imageData, previewMessage, {
          stats: encodeImg.value
        });
        livePsnrDb.value = Stego.computePsnr(encodeImg.value.imageData.data, encoded.data);
        lastPreviewFrame = {
          data: encoded.data,
          width: encoded.width,
          height: encoded.height
        };
        hasLivePreview.value = true;
        livePreviewStale.value = false;

        await nextTick();
        paintFrameToCanvas(lastPreviewFrame);
      } catch (err) {
        encodeError.value = err.message || 'No se pudo generar la vista previa degradada.';
      } finally {
        isRenderingPreview.value = false;
      }
    }

    watch([message, encodePassword, useCompression, useScatter], () => {
      if (encodeResult.value) {
        clearEncodeResult();
      }
      if (encodeError.value && encodeImg.value?.maxTotalBytes > 0) {
        encodeError.value = '';
      }
    });

    // Redimensionado previo opcional (máx. 1600 px) preservando sourceFile original.
    watch(resizeBeforeEncode, async (enabled) => {
      const sourceFile = encodeSourceFile.value;
      if (!sourceFile || !canResizeEncode.value) return;
      if (enabled === Boolean(encodeImg.value?.isResized)) return;

      const mySeq = ++encodeLoadSeq;
      isResizingImage.value = true;
      encodeError.value = '';
      clearEncodeResult();
      resetLivePreview();

      try {
        const nextLoaded = enabled
          ? await loadResizedImageFile(sourceFile, MAX_RESIZE_DIM)
          : {
              ...(await Stego.loadImageFile(sourceFile)),
              fileSize: sourceFile.size,
              isResized: false
            };

        if (mySeq !== encodeLoadSeq) {
          if (nextLoaded.previewUrl) {
            URL.revokeObjectURL(nextLoaded.previewUrl);
          }
          return;
        }

        if (encodeImg.value?.previewUrl) {
          URL.revokeObjectURL(encodeImg.value.previewUrl);
        }
        encodeImg.value = nextLoaded;

        if (nextLoaded.opaquePixels === 0 || nextLoaded.maxTotalBytes === 0) {
          encodeError.value =
            'Esta imagen no tiene suficientes píxeles opacos (A = 255) para ocultar un mensaje.';
        }
      } catch (err) {
        if (mySeq === encodeLoadSeq) {
          encodeError.value = err.message || 'No se pudo aplicar el redimensionado previo.';
        }
      } finally {
        if (mySeq === encodeLoadSeq) {
          isResizingImage.value = false;
        }
      }
    });

    // Estimación con debounce (250 ms) + guardia de secuencia (reqSeq) para compresión deflate-raw.
    watch([message, useCompression], () => {
      clearTimeout(compressionTimer);
      compressionTimer = null;
      compressionReqSeq += 1;

      if (!isCompressedActive.value || messageBytes.value === 0) {
        estimatedCompressedBytes.value = null;
        isEstimatingCompression.value = false;
        return;
      }

      const mySeq = compressionReqSeq;
      const currentText = message.value;
      const rawLen = messageBytes.value;
      isEstimatingCompression.value = true;

      compressionTimer = setTimeout(async () => {
        try {
          const compressed = await Stego.compressRaw(utf8Encoder.encode(currentText));
          if (mySeq !== compressionReqSeq) return;
          estimatedCompressedBytes.value = Math.min(rawLen, compressed.length);
        } catch {
          if (mySeq !== compressionReqSeq) return;
          estimatedCompressedBytes.value = rawLen;
        } finally {
          if (mySeq === compressionReqSeq) {
            isEstimatingCompression.value = false;
          }
        }
      }, 250);
    });

    watch(
      [effectivePayloadBytes, encodeImg, isEncryptedEncode, isScatteredEncode, isEstimatingCompression],
      () => {
        clearTimeout(previewTimer);
        previewTimer = null;

        if (isEstimatingCompression.value) {
          return;
        }

        if (!isDegrading.value || effectivePayloadBytes.value > capacityBudget.value.maxTotalBytes) {
          resetLivePreview();
          return;
        }

        if (isLargeImage.value) {
          livePreviewStale.value = true;
          return;
        }

        previewTimer = setTimeout(() => {
          renderDegradedPreview();
        }, 180);
      }
    );

    // Al volver a la pestaña "Ocultar mensaje", el <canvas> se remonta y necesita repintado.
    watch(activeTab, async (tab) => {
      if (tab === 'encode' && lastPreviewFrame && isDegrading.value) {
        await nextTick();
        paintFrameToCanvas(lastPreviewFrame);
      }
    });

    function onWindowPaste(event) {
      const file = extractPastedImageFile(event);
      if (!file) return;

      event.preventDefault();
      const namedFile =
        file.name && file.name.trim()
          ? file
          : new File([file], 'portapapeles.png', { type: file.type || 'image/png' });

      if (activeTab.value === 'encode') {
        loadEncodeFile(namedFile);
      } else if (activeTab.value === 'decode') {
        loadDecodeFile(namedFile, { fromPaste: true });
      }
    }

    onMounted(() => {
      window.addEventListener('paste', onWindowPaste);
    });

    onUnmounted(() => {
      window.removeEventListener('paste', onWindowPaste);
      clearTimeout(compressionTimer);
      clearTimeout(previewTimer);
      clearTimeout(copyTimer);
      revokeEncodeUrls();
      if (decodeImg.value?.previewUrl) {
        URL.revokeObjectURL(decodeImg.value.previewUrl);
      }
    });

    async function loadSampleImage() {
      encodeError.value = '';
      try {
        const sampleFile = await createSampleImageFile();
        await loadEncodeFile(sampleFile);
      } catch (err) {
        encodeError.value = err.message || 'No se pudo crear la imagen de ejemplo.';
      }
    }

    async function simulateNextPlane() {
      if (!canSimulateNextPlane.value) return;

      const currentPlanes = qualityInfo.value.planesUsed;
      const targetPlane = Math.max(2, currentPlanes + 1);
      const budget = capacityBudget.value;
      const opaque = encodeImg.value.opaquePixels;

      let targetStoredPlainBytes;
      if (isScatteredEncode.value) {
        const remainingOpaque = Math.max(0, opaque - HEADER_OPAQUE_PIXELS_ENCRYPTED);
        targetStoredPlainBytes = Math.min(
          budget.maxTotalBytes,
          Math.max(1, Math.floor((targetPlane * remainingOpaque * 3) / 8) - Stego.GCM_TAG_BYTES)
        );
      } else {
        targetStoredPlainBytes = Math.min(
          budget.maxTotalBytes,
          Math.max(1, Math.floor((targetPlane * encodeImg.value.losslessBits) / 8) - budget.overheadBytes)
        );
      }

      if (!isCompressedActive.value) {
        const currentBytes = messageBytes.value;
        if (currentBytes >= targetStoredPlainBytes) return;

        const chunk =
          'Stego LSB: prueba de degradacion progresiva en planos de bits [0123456789/AaBbCc]. ';
        const prefix = message.value.length > 0 && !message.value.endsWith('\n') ? '\n' : '';
        const needed = targetStoredPlainBytes - currentBytes - prefix.length;

        if (needed <= 0) {
          message.value = message.value + 'x'.repeat(targetStoredPlainBytes - currentBytes);
        } else {
          const filler = chunk.repeat(Math.ceil(needed / chunk.length)).slice(0, needed);
          message.value = message.value + prefix + filler;
        }
        return;
      }

      // Con deflate-raw activo, usamos ASCII de alta entropía calibrado para alcanzar el plano objetivo.
      const baseText = message.value;
      const prefix = baseText.length > 0 && !baseText.endsWith('\n') ? '\n' : '';
      const currentEffective = effectivePayloadBytes.value;
      if (currentEffective >= targetStoredPlainBytes) return;

      const deltaNeeded = Math.max(16, targetStoredPlainBytes - currentEffective);
      let extraLen = Math.min(
        Stego.MAX_DECOMPRESSED_BYTES - messageBytes.value - prefix.length,
        Math.ceil(deltaNeeded * 1.24)
      );
      if (extraLen <= 0) return;

      let candidate = baseText + prefix + generateHighEntropyAscii(extraLen);
      let rawLen = Stego.utf8ByteLength(candidate);
      let effectiveLen = rawLen;

      try {
        const c1 = await Stego.compressRaw(utf8Encoder.encode(candidate));
        effectiveLen = Math.min(rawLen, c1.length);

        if (effectiveLen > budget.maxTotalBytes) {
          const ratio = (budget.maxTotalBytes / effectiveLen) * 0.96;
          extraLen = Math.max(1, Math.floor(extraLen * ratio));
          candidate = baseText + prefix + generateHighEntropyAscii(extraLen);
          rawLen = Stego.utf8ByteLength(candidate);
          const c2 = await Stego.compressRaw(utf8Encoder.encode(candidate));
          effectiveLen = Math.min(rawLen, c2.length);
        } else if (effectiveLen < targetStoredPlainBytes && targetStoredPlainBytes < budget.maxTotalBytes) {
          const missing = targetStoredPlainBytes - effectiveLen;
          const topUp = Math.ceil(missing * 1.2);
          candidate = candidate + generateHighEntropyAscii(topUp);
          rawLen = Stego.utf8ByteLength(candidate);
          const c2 = await Stego.compressRaw(utf8Encoder.encode(candidate));
          effectiveLen = Math.min(rawLen, c2.length);
          if (effectiveLen > budget.maxTotalBytes) {
            candidate = candidate.slice(
              0,
              Math.max(baseText.length, candidate.length - Math.ceil((effectiveLen - budget.maxTotalBytes) * 1.3))
            );
            rawLen = Stego.utf8ByteLength(candidate);
            const c3 = await Stego.compressRaw(utf8Encoder.encode(candidate));
            effectiveLen = Math.min(rawLen, c3.length);
          }
        }
      } catch {
        // Fallback seguro sin compresión estimada.
      }

      message.value = candidate;
      await nextTick();
      clearTimeout(compressionTimer);
      compressionTimer = null;
      compressionReqSeq += 1;
      estimatedCompressedBytes.value = effectiveLen;
      isEstimatingCompression.value = false;
    }

    function triggerEncodePicker() {
      encodeFileInput.value?.click();
    }

    function triggerDecodePicker() {
      decodeFileInput.value?.click();
    }

    function onEncodeDragEnter() {
      encodeDragDepth += 1;
      isDraggingEncode.value = true;
    }

    function onEncodeDragLeave() {
      encodeDragDepth = Math.max(0, encodeDragDepth - 1);
      if (encodeDragDepth === 0) {
        isDraggingEncode.value = false;
      }
    }

    async function onDropEncodeFile(event) {
      encodeDragDepth = 0;
      isDraggingEncode.value = false;
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      await loadEncodeFile(file);
    }

    function onDecodeDragEnter() {
      decodeDragDepth += 1;
      isDraggingDecode.value = true;
    }

    function onDecodeDragLeave() {
      decodeDragDepth = Math.max(0, decodeDragDepth - 1);
      if (decodeDragDepth === 0) {
        isDraggingDecode.value = false;
      }
    }

    async function onDropDecodeFile(event) {
      decodeDragDepth = 0;
      isDraggingDecode.value = false;
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      await loadDecodeFile(file, { fromPaste: false });
    }

    async function loadEncodeFile(file) {
      if (!file) return;

      const mySeq = ++encodeLoadSeq;
      revokeEncodeUrls();
      resetLivePreview();
      encodeSourceFile.value = null;
      encodeOriginalDims.value = null;
      resizeBeforeEncode.value = false;
      isResizingImage.value = false;
      splitPercent.value = 50;
      encodeImg.value = null;
      encodeError.value = '';

      try {
        const loaded = await Stego.loadImageFile(file);
        if (mySeq !== encodeLoadSeq) {
          if (loaded.previewUrl) {
            URL.revokeObjectURL(loaded.previewUrl);
          }
          return;
        }

        encodeSourceFile.value = file;
        encodeOriginalDims.value = {
          width: loaded.width,
          height: loaded.height,
          fileSize: file.size
        };
        encodeImg.value = {
          ...loaded,
          fileSize: file.size,
          isResized: false
        };
        if (loaded.opaquePixels === 0 || loaded.maxTotalBytes === 0) {
          encodeError.value =
            'Esta imagen no tiene suficientes píxeles opacos (A = 255) para ocultar un mensaje.';
        }
      } catch (err) {
        if (mySeq === encodeLoadSeq) {
          encodeError.value = err.message || 'No se pudo cargar la imagen.';
        }
      }
    }

    async function onSelectEncodeFile(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      await loadEncodeFile(file);
    }

    async function handleEncode() {
      if (!canEncode.value) return;

      isEncoding.value = true;
      encodeError.value = '';

      try {
        await nextTick();
        await waitForPaint();

        const encoded = await Stego.encodePayload(encodeImg.value.imageData, message.value, {
          password: encodePassword.value,
          compress: useCompression.value,
          scatter: useScatter.value,
          stats: encodeImg.value
        });
        const psnrDb =
          encoded.planesUsed > 1
            ? Stego.computePsnr(encodeImg.value.imageData.data, encoded.data)
            : null;
        const blob = await Stego.imageDataToPngBlob(
          encoded.data,
          encoded.width,
          encoded.height
        );

        clearEncodeResult();

        const downloadUrl = URL.createObjectURL(blob);
        const downloadName =
          encodeImg.value.fileName.replace(/\.[^.]+$/, '') + '-secreto.png';
        const actualUsagePercent =
          encoded.planesUsed > 1
            ? encoded.quality.overallPercent
            : encoded.quality.losslessPercent;

        encodeResult.value = {
          blob,
          inputSize: encodeImg.value.fileSize ?? 0,
          outputSize: blob.size,
          downloadUrl,
          downloadName,
          version: encoded.version,
          encrypted: encoded.encrypted,
          compressed: encoded.compressed,
          scattered: encoded.scattered,
          originalBytes: encoded.originalBytes,
          compressedBytes: encoded.compressedBytes,
          storedBytes: encoded.storedBytes,
          messageBytes: encoded.messageBytes,
          usedBits: encoded.usedBits,
          planesUsed: encoded.planesUsed,
          quality: encoded.quality,
          psnrDb,
          usagePercent: actualUsagePercent
        };

        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = downloadName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (err) {
        encodeError.value = err.message || 'Error al codificar el mensaje.';
      } finally {
        isEncoding.value = false;
      }
    }

    async function verifyEncodedInDecode() {
      if (!encodeResult.value?.blob) return;
      const file = new File(
        [encodeResult.value.blob],
        encodeResult.value.downloadName,
        { type: 'image/png' }
      );
      activeTab.value = 'decode';
      await loadDecodeFile(file, { fromPaste: false });
    }

    async function runDecodePayload(password) {
      if (!decodeImg.value) return;

      isDecoding.value = true;
      decodeError.value = '';

      try {
        await nextTick();
        await waitForPaint();

        const result = await Stego.decodePayload(decodeImg.value.imageData, {
          password,
          stats: decodeImg.value
        });
        const baseBits = result.planesUsed > 1 ? result.maxTotalBits : result.losslessBits;
        decoded.value = {
          ...result,
          baseBits,
          usagePercent: baseBits > 0 ? (result.usedBits / baseBits) * 100 : 0
        };
      } catch (err) {
        if (err?.code === 'WRONG_PASSWORD') {
          decodeError.value =
            'Contraseña incorrecta o la imagen fue alterada/recomprimida. Verifica la clave e intenta nuevamente.';
        } else {
          const baseMessage = err.message || 'No se pudo leer el mensaje de la imagen.';
          decodeError.value = decodeFromPaste.value
            ? `${baseMessage} Nota: pegar una imagen desde el portapapeles suele recodificar los píxeles y alterar los bits LSB; prefiere arrastrar o seleccionar el archivo .png original.`
            : baseMessage;
        }
      } finally {
        isDecoding.value = false;
      }
    }

    async function handleDecrypt() {
      if (!decodeImg.value || !decodeMeta.value?.encrypted || isDecoding.value) return;
      if (!decodePassword.value) {
        decodeError.value = 'Ingresa la contraseña para descifrar el mensaje.';
        return;
      }
      await runDecodePayload(decodePassword.value);
    }

    async function loadDecodeFile(file, { fromPaste = false } = {}) {
      if (!file) return;

      if (decodeImg.value?.previewUrl) {
        URL.revokeObjectURL(decodeImg.value.previewUrl);
      }
      clearTimeout(copyTimer);
      copyTimer = null;
      decodeImg.value = null;
      decodeMeta.value = null;
      decodePassword.value = '';
      showDecodePassword.value = false;
      isDecoding.value = false;
      decodeFromPaste.value = fromPaste;
      decoded.value = null;
      decodeError.value = '';
      copied.value = false;

      try {
        const loaded = await Stego.loadImageFile(file);
        decodeImg.value = loaded;

        const meta = Stego.inspectImageData(loaded.imageData, loaded);
        if (!meta.found) {
          throw new Error(
            'No se encontró ningún mensaje oculto en esta imagen. Verifica que sea el PNG original sin compresión.'
          );
        }

        decodeMeta.value = meta;

        if (meta.encrypted) {
          if (!cryptoSupported) {
            decodeError.value =
              'Esta imagen contiene un mensaje cifrado con AES-256-GCM, pero tu navegador no habilita Web Crypto API en este contexto. Ábrelo desde HTTPS (GitHub Pages) o localhost.';
          }
          return;
        }

        await runDecodePayload('');
      } catch (err) {
        const baseMessage = err.message || 'No se pudo leer el mensaje de la imagen.';
        decodeError.value = fromPaste
          ? `${baseMessage} Nota: pegar una imagen desde el portapapeles suele recodificar los píxeles y alterar los bits LSB; prefiere arrastrar o seleccionar el archivo .png original.`
          : baseMessage;
      }
    }

    async function onSelectDecodeFile(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      await loadDecodeFile(file, { fromPaste: false });
    }

    async function copyMessage() {
      if (!decoded.value?.message) return;
      const text = decoded.value.message;

      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          throw new Error('Clipboard API no disponible');
        }
      } catch {
        // Respaldo para contextos donde navigator.clipboard puede estar restringido.
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      copied.value = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied.value = false;
      }, 2000);
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function formatNumber(n) {
      return Number(n || 0).toLocaleString('es-CL');
    }

    function formatPercent(pct) {
      if (pct > 0 && pct < 0.01) return '< 0.01%';
      return `${pct.toFixed(2)}%`;
    }

    function formatPsnr(psnr) {
      if (psnr === null || psnr === undefined || Number.isNaN(psnr)) return '—';
      if (!Number.isFinite(psnr)) return '∞ dB';
      return `${psnr.toFixed(1)} dB`;
    }

    return {
      MAX_RESIZE_DIM,
      activeTab,
      cryptoSupported,
      compressionSupported,
      theme,
      isDark,
      toggleTheme,
      encodeFileInput,
      encodeOriginalDims,
      resizeBeforeEncode,
      isResizingImage,
      canResizeEncode,
      encodeImg,
      message,
      encodePassword,
      showEncodePassword,
      useCompression,
      useScatter,
      encodeError,
      encodeResult,
      isEncoding,
      isDraggingEncode,
      isEstimatingCompression,
      livePreviewCanvas,
      livePsnrDb,
      splitPercent,
      hasLivePreview,
      livePreviewStale,
      isRenderingPreview,
      decodeFileInput,
      decodeImg,
      decodeMeta,
      decodePassword,
      showDecodePassword,
      isDecoding,
      decoded,
      decodeError,
      isDraggingDecode,
      copied,
      isEncryptedEncode,
      isScatteredEncode,
      isCompressedActive,
      messageBytes,
      capacityBudget,
      effectivePayloadBytes,
      compressionWillSave,
      usedBitsPreview,
      qualityInfo,
      isOverCapacity,
      isDegrading,
      isLargeImage,
      showingDegradedCanvas,
      canEncode,
      canSimulateNextPlane,
      progressPercent,
      progressBarClass,
      qualityBadgeClass,
      qualityBadgeLabel,
      needsDecodePassword,
      clearEncode,
      clearDecode,
      loadSampleImage,
      renderDegradedPreview,
      simulateNextPlane,
      triggerEncodePicker,
      triggerDecodePicker,
      onEncodeDragEnter,
      onEncodeDragLeave,
      onDropEncodeFile,
      onDecodeDragEnter,
      onDecodeDragLeave,
      onDropDecodeFile,
      loadEncodeFile,
      onSelectEncodeFile,
      handleEncode,
      verifyEncodedInDecode,
      handleDecrypt,
      loadDecodeFile,
      onSelectDecodeFile,
      copyMessage,
      formatBytes,
      formatNumber,
      formatPercent,
      formatPsnr
    };
  }
}).mount('#app');
