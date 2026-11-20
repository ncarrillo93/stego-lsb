# Stego LSB

MVP mínimo y educativo de esteganografía **LSB (Least Significant Bit)** 100% en el navegador, construido con **HTML5 + Bootstrap 5 + Vue 3 (Composition API vía CDN)** sin dependencias de Node.js ni compilación.

## 1. Cómo probarlo en local

1. Abre la carpeta `stego-lsb`.
2. Haz doble clic en `index.html` para abrirlo directamente en tu navegador (funciona tanto con `file://` como desde un servidor estático).
3. En la pestaña **Ocultar mensaje**, carga una imagen, escribe un texto y haz clic en **Codificar y descargar PNG**.
4. Cambia a la pestaña **Leer mensaje** y selecciona el PNG descargado para recuperar el texto original.

## 2. Cómo funciona el algoritmo LSB (`stego.js`)

El motor binario opera directamente sobre el arreglo RGBA (`ImageData.data`) del `<canvas>` HTML5:

1. **Filtrado de píxeles opacos (`A = 255`):** Solo se escriben y leen bits en píxeles completamente opacos. Los navegadores aplican *alpha premultiplicado* al dibujar y leer píxeles con transparencia (`A < 255`), lo que redondea los valores RGB y destruiría los bits ocultos.
2. **3 bits por píxel opaco:** Se modifica únicamente el bit menos significativo (`& 0xFE | bit`) de los canales **R, G y B**, por lo que cada canal cambia como máximo en `±1` (imperceptible visualmente).
3. **Formato binario del payload:**
   - **Bytes 0–3:** Firma mágica `"STG1"` (`0x53 0x54 0x47 0x31`) para validar si la imagen contiene un mensaje.
   - **Bytes 4–7:** Longitud del mensaje en bytes (`uint32` big-endian).
   - **Bytes 8 en adelante:** Texto codificado en **UTF-8** (`TextEncoder` / `TextDecoder`), compatible con tildes, `ñ` y emojis.

### Autocomprobación en consola
Puedes verificar la lógica binaria abriendo las herramientas de desarrollo del navegador (`F12` → Consola) y ejecutando:

```js
Stego.selfCheck(); // Devuelve true si todas las aserciones pasan
```

## 5. Advertencia importante sobre compresión

Para que el destinatario pueda leer el mensaje, debes enviarle el archivo `.png` generado **sin compresión** (como **Documento / Archivo adjunto** en WhatsApp/Telegram, o por correo/Google Drive/WeTransfer). Si lo envías en modo **Foto**, la plataforma lo recomprimirá a JPEG/WebP y destruirá los bits menos significativos.
