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

function readStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'auto') {
      return value;
    }
  } catch {
    // Almacenamiento no disponible o restringido.
  }
  return 'auto';
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

createApp({
  setup() {
    const activeTab = ref('encode');

    // Tema visual Bootstrap 5.3 ('auto' | 'light' | 'dark')
    const theme = ref(readStoredTheme());
    const darkMediaQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

    function resolveTheme(mode) {
      if (mode === 'auto') {
        return darkMediaQuery?.matches ? 'dark' : 'light';
      }
      return mode;
    }

    function applyTheme(mode) {
      document.documentElement.setAttribute('data-bs-theme', resolveTheme(mode));
    }

    function onSystemThemeChange() {
      if (theme.value === 'auto') {
        applyTheme('auto');
      }
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
    const encodeImg = shallowRef(null);
    const message = ref('');
    const encodeError = ref('');
    const encodeResult = shallowRef(null);
    const isEncoding = ref(false);
    const isDraggingEncode = ref(false);
    let encodeDragDepth = 0;

    // Vista previa en vivo de degradación progresiva (<canvas>)
    const livePreviewCanvas = ref(null);
    const livePsnrDb = ref(null);
    const showOriginalPreview = ref(false);
    const hasLivePreview = ref(false);
    const livePreviewStale = ref(false);
    const isRenderingPreview = ref(false);
    let previewTimer = null;
    let lastPreviewFrame = null;

    // Estado de decodificación ("Leer mensaje")
    const decodeFileInput = ref(null);
    const decodeImg = shallowRef(null);
    const decoded = shallowRef(null);
    const decodeError = ref('');
    const isDraggingDecode = ref(false);
    let decodeDragDepth = 0;
    const copied = ref(false);
    let copyTimer = null;

    const messageBytes = computed(() => Stego.utf8ByteLength(message.value));

    const usedBitsPreview = computed(() =>
      messageBytes.value > 0 ? (Stego.getOverheadBytes() + messageBytes.value) * 8 : 0
    );

    const qualityInfo = computed(() =>
      Stego.estimateQuality(usedBitsPreview.value, encodeImg.value?.opaquePixels || 0)
    );

    const isOverCapacity = computed(
      () => Boolean(encodeImg.value) && messageBytes.value > encodeImg.value.maxTotalBytes
    );

    const isDegrading = computed(
      () =>
        Boolean(encodeImg.value) &&
        !isOverCapacity.value &&
        qualityInfo.value.planesUsed > 1
    );

    const isLargeImage = computed(
      () => Boolean(encodeImg.value) && encodeImg.value.totalPixels > Stego.WARN_PIXELS
    );

    const showingDegradedCanvas = computed(
      () => isDegrading.value && !showOriginalPreview.value && hasLivePreview.value
    );

    const canEncode = computed(
      () =>
        Boolean(encodeImg.value) &&
        encodeImg.value.maxTotalBytes > 0 &&
        messageBytes.value > 0 &&
        !isOverCapacity.value &&
        !isEncoding.value
    );

    const canSimulateNextPlane = computed(
      () =>
        Boolean(encodeImg.value) &&
        encodeImg.value.maxTotalBytes > 0 &&
        !isOverCapacity.value &&
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
      showOriginalPreview.value = false;
    }

    function revokeEncodeUrls() {
      if (encodeImg.value?.previewUrl) {
        URL.revokeObjectURL(encodeImg.value.previewUrl);
      }
      clearEncodeResult();
    }

    function clearEncode() {
      revokeEncodeUrls();
      resetLivePreview();
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

    async function renderDegradedPreview() {
      if (!encodeImg.value || !isDegrading.value) {
        resetLivePreview();
        return;
      }

      isRenderingPreview.value = true;
      try {
        await nextTick();
        if (isLargeImage.value) {
          await waitForPaint();
        }

        if (!encodeImg.value || !isDegrading.value) {
          resetLivePreview();
          return;
        }

        const encoded = Stego.encodeImageData(encodeImg.value.imageData, message.value, {
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

    watch(message, () => {
      if (encodeResult.value) {
        clearEncodeResult();
      }
    });

    watch([message, encodeImg], () => {
      clearTimeout(previewTimer);
      previewTimer = null;

      if (!isDegrading.value) {
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
    });

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
      darkMediaQuery?.addEventListener?.('change', onSystemThemeChange);
    });

    onUnmounted(() => {
      window.removeEventListener('paste', onWindowPaste);
      darkMediaQuery?.removeEventListener?.('change', onSystemThemeChange);
      clearTimeout(previewTimer);
      clearTimeout(copyTimer);
      revokeEncodeUrls();
      if (decodeImg.value?.previewUrl) {
        URL.revokeObjectURL(decodeImg.value.previewUrl);
      }
    });

    function simulateNextPlane() {
      if (!canSimulateNextPlane.value) return;

      const currentPlanes = qualityInfo.value.planesUsed;
      const targetPlane = Math.max(2, currentPlanes + 1);
      const overhead = Stego.getOverheadBytes();
      const targetBytes = Math.min(
        encodeImg.value.maxTotalBytes,
        Math.max(1, Math.floor((targetPlane * encodeImg.value.losslessBits) / 8) - overhead)
      );

      const currentBytes = messageBytes.value;
      if (currentBytes >= targetBytes) return;

      const chunk =
        'Stego LSB: prueba de degradacion progresiva en planos de bits [0123456789/AaBbCc]. ';
      const prefix = message.value.length > 0 && !message.value.endsWith('\n') ? '\n' : '';
      const needed = targetBytes - currentBytes - prefix.length;

      if (needed <= 0) {
        message.value = message.value + 'x'.repeat(targetBytes - currentBytes);
        return;
      }

      const filler = chunk.repeat(Math.ceil(needed / chunk.length)).slice(0, needed);
      message.value = message.value + prefix + filler;
      showOriginalPreview.value = false;
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

      revokeEncodeUrls();
      resetLivePreview();
      encodeImg.value = null;
      encodeError.value = '';

      try {
        const loaded = await Stego.loadImageFile(file);
        encodeImg.value = loaded;
        if (loaded.opaquePixels === 0 || loaded.maxTotalBytes === 0) {
          encodeError.value =
            'Esta imagen no tiene suficientes píxeles opacos (A = 255) para ocultar un mensaje.';
        }
      } catch (err) {
        encodeError.value = err.message || 'No se pudo cargar la imagen.';
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

        const encoded = Stego.encodeImageData(encodeImg.value.imageData, message.value, {
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
          downloadUrl,
          downloadName,
          version: encoded.version,
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

    async function loadDecodeFile(file, { fromPaste = false } = {}) {
      if (!file) return;

      if (decodeImg.value?.previewUrl) {
        URL.revokeObjectURL(decodeImg.value.previewUrl);
      }
      clearTimeout(copyTimer);
      copyTimer = null;
      decodeImg.value = null;
      decoded.value = null;
      decodeError.value = '';
      copied.value = false;

      try {
        const loaded = await Stego.loadImageFile(file);
        decodeImg.value = loaded;

        const result = Stego.decodeImageData(loaded.imageData, loaded);
        const baseBits = result.planesUsed > 1 ? result.maxTotalBits : result.losslessBits;
        decoded.value = {
          ...result,
          baseBits,
          usagePercent: baseBits > 0 ? (result.usedBits / baseBits) * 100 : 0
        };
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
      activeTab,
      theme,
      encodeFileInput,
      encodeImg,
      message,
      encodeError,
      encodeResult,
      isEncoding,
      isDraggingEncode,
      livePreviewCanvas,
      livePsnrDb,
      showOriginalPreview,
      hasLivePreview,
      livePreviewStale,
      isRenderingPreview,
      decodeFileInput,
      decodeImg,
      decoded,
      decodeError,
      isDraggingDecode,
      copied,
      messageBytes,
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
      clearEncode,
      clearDecode,
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
