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
//
// Única excepción, y controlada: el recorte a la tabla (opción `recortarTabla`), que
// devuelve la zona recortada para poder deshacer el cambio de coordenadas.

import { detectarZonaTabla, type Renglones, type Zona } from "./tableCrop";

export interface ImagenPreparada {
  dataUrl: string;
  mimeType: string;
  base64: string;
  /** Zona de la imagen original que contiene esta imagen, si se recortó a la tabla. */
  recorte?: Zona;
  /** Geometría de los renglones medida sobre la página original (solo si hay recorte). */
  renglones?: Renglones;
}

export function cargarImagen(url: string): Promise<HTMLImageElement> {
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
// `maxSide` = 2200: algo por debajo de los 2600 px a los que se rasterizan los PDF. Desde
// que la extracción pasa por /api/gemini, cada envío tiene un techo de 4.5 MB (Vercel), y
// a 2600 px un PDF de 3 hojas ya no cabía. 2200 px recorta ~30% del área y sigue dejando a
// un A4 vertical con 20 filas unos 70 px por renglón, de sobra para dígitos manuscritos.
// No bajar mucho más: quedarse corto de píxeles vuelve ilegibles los dígitos en casillas.
// Solo afecta a lo que se ENVÍA: el visor y los recortes de relectura usan la página a
// resolución completa, y las coordenadas del modelo son relativas (0-1000), así que la
// marca sigue cayendo en su fila aunque la imagen enviada sea más pequeña.
//
// `recortarTabla`: recorta a la zona de renglones + nombre + DNI (ver tableCrop.ts). Es la
// ÚNICA operación que mueve píxeles, y por eso la zona recortada se devuelve en `recorte`:
// quien reciba coordenadas del modelo debe convertirlas con ella a las de la hoja entera.
// El recorte sale de la página a resolución completa, así que además de concentrar el
// presupuesto de tokens del modelo, cada trazo llega con más píxeles que antes.
export async function enhanceForOcr(
  dataUrl: string,
  maxSide = 2200,
  opciones: { recortarTabla?: boolean } = {}
): Promise<ImagenPreparada> {
  try {
    const img = await cargarImagen(dataUrl);
    const anchoImg = img.naturalWidth, altoImg = img.naturalHeight;
    if (!anchoImg || !altoImg) return partirDataUrl(dataUrl);

    const tabla = opciones.recortarTabla ? detectarZonaTabla(img, anchoImg, altoImg) : null;
    const zona = tabla?.zona;
    const sx = zona ? Math.round(zona.x0 * anchoImg) : 0;
    const sy = zona ? Math.round(zona.y0 * altoImg) : 0;
    const W0 = zona ? Math.round((zona.x1 - zona.x0) * anchoImg) : anchoImg;
    const H0 = zona ? Math.round((zona.y1 - zona.y0) * altoImg) : altoImg;

    const escala = Math.min(1, maxSide / Math.max(W0, H0));
    const W = Math.max(1, Math.round(W0 * escala));
    const H = Math.max(1, Math.round(H0 * escala));

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!ctx) return partirDataUrl(dataUrl);
    ctx.fillStyle = "#fff";               // los PNG con transparencia irían a negro
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, sx, sy, W0, H0, 0, 0, W, H);

    const src = ctx.getImageData(0, 0, W, H);
    const px = src.data;
    const n = W * H;

    // --- Gris por canal mínimo --------------------------------------------------
    // La tinta de color es oscura en su canal más débil: un bolígrafo azul claro tiene
    // mucho azul pero poco rojo. Con la luminancia clásica ese trazo quedaba en un gris
    // medio fácil de perder; con el mínimo de los tres canales queda casi negro.
    const tono = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      tono[i] = Math.min(px[o], px[o + 1], px[o + 2]);
    }

    // --- Iluminación de fondo -------------------------------------------------
    // La luz del papel en cada zona es su píxel MÁS CLARO, no el promedio. Antes se
    // estimaba reduciendo la imagen con drawImage: el navegador muestreaba unos pocos
    // píxeles sueltos por bloque, y cuando caían sobre tinta daba el papel por oscuro y
    // "blanqueaba" la zona, borrando dígitos enteros (manchas grises y casillas de DNI
    // medio vacías en lo que recibía el modelo). El máximo por bloque no depende de
    // cuánta tinta haya ni de dónde caiga.
    const kf = Math.max(8, Math.round(Math.max(W, H) / 48));
    const bw = Math.ceil(W / kf);
    const bh = Math.ceil(H / kf);
    const bloques = new Uint8ClampedArray(bw * bh);
    for (let y = 0; y < H; y++) {
      const fila = ((y / kf) | 0) * bw;
      const off = y * W;
      for (let x = 0; x < W; x++) {
        const b = fila + ((x / kf) | 0);
        if (tono[off + x] > bloques[b]) bloques[b] = tono[off + x];
      }
    }
    // Dilatación 3x3: un bloque tapado del todo por tinta (una firma gruesa, una franja
    // sombreada) toma la luz del papel de sus vecinos.
    const mini = document.createElement("canvas");
    mini.width = bw; mini.height = bh;
    const mctx = mini.getContext("2d");
    if (!mctx) return partirDataUrl(dataUrl);
    const luzBloques = mctx.createImageData(bw, bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = by + dy;
          if (yy < 0 || yy >= bh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = bx + dx;
            if (xx >= 0 && xx < bw && bloques[yy * bw + xx] > m) m = bloques[yy * bw + xx];
          }
        }
        const o = (by * bw + bx) * 4;
        luzBloques.data[o] = luzBloques.data[o + 1] = luzBloques.data[o + 2] = m;
        luzBloques.data[o + 3] = 255;
      }
    }
    mctx.putImageData(luzBloques, 0, 0);

    // Ampliar la rejilla a tamaño completo sí puede hacerlo el navegador: al agrandar
    // interpola con suavidad, el problema de muestreo solo existe al reducir.
    const fondo = document.createElement("canvas");
    fondo.width = W; fondo.height = H;
    const fctx = fondo.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!fctx) return partirDataUrl(dataUrl);
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "high";
    // La rejilla cubre bw*kf x bh*kf píxeles, algo más que la imagen si no divide exacto.
    fctx.drawImage(mini, 0, 0, bw * kf, bh * kf);
    const bg = fctx.getImageData(0, 0, W, H).data;

    // --- Corrección de iluminación + histograma -------------------------------
    const gris = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const luz = Math.max(1, bg[i * 4]);
      const v = Math.min(255, (tono[i] / luz) * 235);   // 235: deja margen antes de saturar
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

    // 0.82: en una imagen ya en escala de grises y de alto contraste, la compresión
    // apenas afecta al trazo (los artefactos JPEG aparecen sobre todo en degradados de
    // color, que aquí no hay) y recorta bastante el peso del envío.
    const lista = partirDataUrl(canvas.toDataURL("image/jpeg", 0.82));
    // La zona exacta que se dibujó (tras redondear a píxeles), no la estimada.
    if (tabla) lista.renglones = tabla.renglones;
    if (zona) lista.recorte = { x0: sx / anchoImg, y0: sy / altoImg, x1: (sx + W0) / anchoImg, y1: (sy + H0) / altoImg };
    return lista;
  } catch (err) {
    console.warn("No se pudo preprocesar la imagen, se envía tal cual:", err);
    return partirDataUrl(dataUrl);
  }
}
