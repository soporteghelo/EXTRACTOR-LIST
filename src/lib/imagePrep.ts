// Preprocesado de imagen para OCR (visión clásica, sin IA).
//
// Objetivo: entregarle a Gemini una imagen limpia — sin sombras, con el texto bien
// separado del papel — para que acierte más en la primera pasada.
//
// REGLA QUE NO SE PUEDE ROMPER: todas las operaciones son FOTOMÉTRICAS (cambian el
// color de cada píxel, nunca su posición). Nada de enderezar, rotar ni recortar.
// El modelo devuelve las coordenadas de cada fila en la imagen que se le manda; si
// aquí se moviera un solo píxel, esas marcas dejarían de cuadrar con el documento
// original que ve el usuario en el visor.

export interface ImagenPreparada {
  dataUrl: string;
  mimeType: string;
  base64: string;
}

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function partirDataUrl(dataUrl: string): ImagenPreparada {
  const coma = dataUrl.indexOf(",");
  const cabecera = dataUrl.slice(0, coma);
  const mime = /data:([^;]+)/.exec(cabecera)?.[1] || "image/jpeg";
  return { dataUrl, mimeType: mime, base64: dataUrl.slice(coma + 1) };
}

/**
 * Limpia una imagen escaneada o fotografiada para que el OCR la lea mejor:
 *
 *  1. Reduce el tamaño solo si es descomunal (menos payload, misma legibilidad).
 *  2. Estima la iluminación del papel y la divide → quita sombras y viñeteado,
 *     que es lo que más arruina una foto de móvil de una ficha de asistencia.
 *  3. Estira el contraste entre los percentiles 2 y 98 → el trazo se vuelve negro
 *     y el papel blanco, sin recortar los extremos por culpa de cuatro píxeles sueltos.
 *
 * No binariza a blanco y negro puro a propósito: en lápiz flojo o bolígrafo claro,
 * el umbral duro se come trazos enteros y el modelo multimodal trabaja peor con
 * imágenes de dos tonos que con un gris bien contrastado.
 *
 * Si algo falla, devuelve la imagen original: preprocesar nunca debe impedir extraer.
 */
export async function enhanceForOcr(dataUrl: string, maxSide = 2400): Promise<ImagenPreparada> {
  try {
    const img = await cargarImagen(dataUrl);
    const W0 = img.naturalWidth, H0 = img.naturalHeight;
    if (!W0 || !H0) return partirDataUrl(dataUrl);

    const escala = Math.min(1, maxSide / Math.max(W0, H0));
    const W = Math.max(1, Math.round(W0 * escala));
    const H = Math.max(1, Math.round(H0 * escala));

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!ctx) return partirDataUrl(dataUrl);
    ctx.fillStyle = "#fff";               // los PNG con transparencia irían a negro
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);

    // --- Iluminación de fondo -------------------------------------------------
    // Miniatura muy pequeña reescalada a tamaño completo: el propio remuestreo del
    // navegador actúa de desenfoque grande y barato. Lo que queda es la luz del
    // papel (sombras, degradados), sin el texto.
    const kf = Math.max(1, Math.round(Math.max(W, H) / 48));
    const bw = Math.max(1, Math.round(W / kf));
    const bh = Math.max(1, Math.round(H / kf));
    const mini = document.createElement("canvas");
    mini.width = bw; mini.height = bh;
    const mctx = mini.getContext("2d");
    if (!mctx) return partirDataUrl(dataUrl);
    mctx.drawImage(canvas, 0, 0, bw, bh);

    const fondo = document.createElement("canvas");
    fondo.width = W; fondo.height = H;
    const fctx = fondo.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!fctx) return partirDataUrl(dataUrl);
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(mini, 0, 0, W, H);

    const src = ctx.getImageData(0, 0, W, H);
    const bg = fctx.getImageData(0, 0, W, H).data;
    const px = src.data;
    const n = W * H;

    // --- Corrección de iluminación + histograma -------------------------------
    const gris = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const lum = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      const luz = Math.max(1, 0.299 * bg[o] + 0.587 * bg[o + 1] + 0.114 * bg[o + 2]);
      const v = Math.min(255, (lum / luz) * 235);   // 235: deja margen antes de saturar
      gris[i] = v;
      hist[v | 0]++;
    }

    // --- Estirado de contraste por percentiles --------------------------------
    const corte = Math.max(1, Math.floor(n * 0.02));
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= corte) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= corte) { hi = v; break; } }
    if (hi - lo < 16) { lo = 0; hi = 255; }        // imagen plana: mejor no tocarla

    const rango = hi - lo;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(255, ((gris[i] - lo) / rango) * 255));
      const o = i * 4;
      px[o] = px[o + 1] = px[o + 2] = v;
      px[o + 3] = 255;
    }
    ctx.putImageData(src, 0, 0);

    // 0.86: en una imagen ya en escala de grises y de alto contraste, bajar de 0.92
    // recorta bastante el peso del envío sin que el trazo pierda definición.
    return partirDataUrl(canvas.toDataURL("image/jpeg", 0.86));
  } catch (err) {
    console.warn("No se pudo preprocesar la imagen, se envía tal cual:", err);
    return partirDataUrl(dataUrl);
  }
}
