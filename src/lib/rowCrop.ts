// Recorte de renglones para la relectura puntual (Fase 4).
//
// Por qué existe: Gemini reparte un presupuesto fijo de tokens por imagen. Una A4 con
// 20 filas a ULTRA_HIGH son 2240 tokens para toda la hoja, así que a cada DNI escrito a
// mano le tocan ~100. Ese mismo renglón recortado y enviado solo recibe los 2240 enteros.
// Es literalmente acercar la lupa, que es lo que hace una persona cuando no distingue
// un 4 de un 9.
//
// Solo se usa sobre las filas que quedaron sin coincidencia en la maestra, así que en un
// documento típico son 1-3 recortes diminutos, no una relectura del documento.

import { cargarImagen, enhanceForOcr } from "./imagePrep";

export interface BBoxNorm {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface RecorteFila {
  id: string;
  base64: string;
  mimeType: string;
}

// La bbox de cada fila es interpolada entre dos anclas que da el modelo, así que arrastra
// error. Un margen generoso arriba y abajo garantiza que el renglón entre entero en el
// recorte aunque la interpolación se haya desviado media línea.
const MARGEN_VERTICAL = 0.5;
const MARGEN_HORIZONTAL = 0.02;

/**
 * Recorta de una página los renglones indicados, a resolución nativa, y les pasa la
 * misma limpieza fotométrica que al resto del pipeline.
 *
 * `bbox` viene normalizada 0-1000 sobre la página completa (el sistema de coordenadas
 * que devuelve el modelo). Si un recorte falla, se omite esa fila en lugar de tumbar
 * toda la operación: releer 2 de 3 filas es mejor que no releer ninguna.
 */
export async function recortarFilas(
  pageDataUrl: string,
  filas: { id: string; bbox: BBoxNorm }[]
): Promise<RecorteFila[]> {
  if (filas.length === 0) return [];

  const img = await cargarImagen(pageDataUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) return [];

  const recortes: RecorteFila[] = [];

  for (const fila of filas) {
    try {
      const y0 = (fila.bbox.ymin / 1000) * H;
      const y1 = (fila.bbox.ymax / 1000) * H;
      const alto = Math.max(1, y1 - y0);
      const padV = alto * MARGEN_VERTICAL;

      // Si las anclas horizontales vinieron degeneradas, se usa el ancho completo:
      // vale más un recorte de más que uno que corte el DNI por la mitad.
      let x0 = (fila.bbox.xmin / 1000) * W;
      let x1 = (fila.bbox.xmax / 1000) * W;
      if (!(x1 - x0 > W * 0.2)) {
        x0 = 0;
        x1 = W;
      } else {
        const padH = (x1 - x0) * MARGEN_HORIZONTAL;
        x0 -= padH;
        x1 += padH;
      }

      const cx = Math.max(0, Math.floor(x0));
      const cy = Math.max(0, Math.floor(y0 - padV));
      const cw = Math.min(W - cx, Math.ceil(x1 - x0 + 2 * (x1 - x0) * MARGEN_HORIZONTAL));
      const ch = Math.min(H - cy, Math.ceil(alto + 2 * padV));
      if (cw < 8 || ch < 8) continue;

      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (!ctx) continue;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);

      // Misma limpieza que el resto del pipeline. En un recorte pequeño la corrección de
      // iluminación es incluso más certera: hay menos variación de luz que estimar.
      const limpio = await enhanceForOcr(canvas.toDataURL("image/png"));
      recortes.push({ id: fila.id, base64: limpio.base64, mimeType: limpio.mimeType });
    } catch (err) {
      console.warn(`No se pudo recortar la fila ${fila.id}:`, err);
    }
  }

  return recortes;
}
