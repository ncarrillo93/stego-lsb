(function () {
  'use strict';

  // Composition API de Vue 3: ref() crea estado reactivo y computed() deriva valores automáticos.
  const { createApp, ref, computed } = Vue;

  createApp({
    setup() {
      const activeTab = ref('encode');

      // Estado de codificación ("Ocultar mensaje")
      const encodeImg = ref(null);
      const message = ref('');
      const encodeError = ref('');
      const encodeResult = ref(null);
      const isEncoding = ref(false);

      // Estado de decodificación ("Leer mensaje")
      const decodeImg = ref(null);
      const decoded = ref(null);
      const decodeError = ref('');
      const copied = ref(false);
      let copyTimer = null;

      const messageBytes = computed(() => Stego.utf8ByteLength(message.value));

      const usedBitsPreview = computed(() =>
        messageBytes.value > 0 ? (Stego.HEADER_BYTES + messageBytes.value) * 8 : 0
      );

      const usagePercent = computed(() => {
        if (!encodeImg.value || encodeImg.value.usableBits === 0) return 0;
        return (usedBitsPreview.value / encodeImg.value.usableBits) * 100;
      });

      const isOverCapacity = computed(
        () => Boolean(encodeImg.value) && messageBytes.value > encodeImg.value.maxMessageBytes
      );

      const canEncode = computed(
        () =>
          Boolean(encodeImg.value) &&
          messageBytes.value > 0 &&
          !isOverCapacity.value &&
          !isEncoding.value
      );

      const progressBarClass = computed(() => {
        if (isOverCapacity.value) return 'bg-danger';
        if (usagePercent.value >= 80) return 'bg-warning';
        return 'bg-primary';
      });

      function revokeEncodeUrls() {
        if (encodeImg.value?.previewUrl) {
          URL.revokeObjectURL(encodeImg.value.previewUrl);
        }
        if (encodeResult.value?.downloadUrl) {
          URL.revokeObjectURL(encodeResult.value.downloadUrl);
        }
      }

      async function onSelectEncodeFile(event) {
        const file = event.target.files?.[0];
        if (!file) return;

        revokeEncodeUrls();
        encodeImg.value = null;
        encodeResult.value = null;
        encodeError.value = '';

        try {
          const loaded = await Stego.loadImageFile(file);
          encodeImg.value = loaded;
          if (loaded.opaquePixels === 0 || loaded.maxMessageBytes === 0) {
            encodeError.value =
              'Esta imagen no tiene suficientes píxeles opacos (A = 255) para ocultar un mensaje.';
          }
        } catch (err) {
          encodeError.value = err.message || 'No se pudo cargar la imagen.';
        }
      }

      async function handleEncode() {
        if (!canEncode.value) return;

        isEncoding.value = true;
        encodeError.value = '';

        try {
          const encoded = Stego.encodeImageData(encodeImg.value.imageData, message.value);
          const blob = await Stego.imageDataToPngBlob(
            encoded.data,
            encoded.width,
            encoded.height
          );

          if (encodeResult.value?.downloadUrl) {
            URL.revokeObjectURL(encodeResult.value.downloadUrl);
          }

          const downloadUrl = URL.createObjectURL(blob);
          const downloadName =
            encodeImg.value.fileName.replace(/\.[^.]+$/, '') + '-secreto.png';
          const actualUsagePercent =
            encoded.usableBits > 0 ? (encoded.usedBits / encoded.usableBits) * 100 : 0;

          encodeResult.value = {
            downloadUrl,
            downloadName,
            messageBytes: encoded.messageBytes,
            usedBits: encoded.usedBits,
            usableBits: encoded.usableBits,
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

      async function onSelectDecodeFile(event) {
        const file = event.target.files?.[0];
        if (!file) return;

        if (decodeImg.value?.previewUrl) {
          URL.revokeObjectURL(decodeImg.value.previewUrl);
        }
        decodeImg.value = null;
        decoded.value = null;
        decodeError.value = '';
        copied.value = false;

        try {
          const loaded = await Stego.loadImageFile(file);
          decodeImg.value = loaded;

          const result = Stego.decodeImageData(loaded.imageData);
          decoded.value = {
            ...result,
            usagePercent: result.usableBits > 0 ? (result.usedBits / result.usableBits) * 100 : 0
          };
        } catch (err) {
          decodeError.value = err.message || 'No se pudo leer el mensaje de la imagen.';
        }
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
          // Respaldo para contextos file:// donde navigator.clipboard puede estar restringido.
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

      return {
        activeTab,
        encodeImg,
        message,
        encodeError,
        encodeResult,
        isEncoding,
        decodeImg,
        decoded,
        decodeError,
        copied,
        messageBytes,
        usedBitsPreview,
        usagePercent,
        isOverCapacity,
        canEncode,
        progressBarClass,
        onSelectEncodeFile,
        handleEncode,
        onSelectDecodeFile,
        copyMessage,
        formatBytes,
        formatNumber,
        formatPercent
      };
    }
  }).mount('#app');
})();
