import * as pdfjsLib from "pdfjs-dist";
// Vite resolves this to a URL string for the worker bundle.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const PAGINAS_A_LA_VEZ = 3;

/**
 * Renderiza cada página de un PDF (en base64) a una imagen data URL (JPEG).
 * Devuelve un array donde el índice 0 = página 1, etc.
 *
 * `onProgress` se llama al terminar cada página para poder mostrar el avance:
 * un PDF de muchas hojas tarda bastante y sin aviso parece que la app se colgó.
 */
export async function renderPdfToImages(
  base64: string,
  targetLongSide = 2600,
  onProgress?: (hechas: number, total: number) => void
): Promise<string[]> {
  const data = base64ToUint8Array(base64);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const images = new Array<string>(pdf.numPages).fill("");
  let hechas = 0;
  let siguiente = 1;

  onProgress?.(0, pdf.numPages);
  // Varias páginas a la vez: la decodificación de cada hoja escaneada ocurre en el worker
  // de pdf.js, así que solaparlas aprovecha los tiempos muertos del hilo principal.
  // Pocas a propósito: cada lienzo de página ocupa ~20 MB mientras se dibuja.
  const trabajador = async () => {
    while (siguiente <= pdf.numPages) {
      const pageNum = siguiente++;
      const page = await pdf.getPage(pageNum);
      // Escala calculada, no fija: una escala 2 sobre un A4 daba 1190x1684 px, muy poco
      // para dígitos manuscritos dentro de casillas. Se apunta a un lado largo concreto
      // para que cada página llegue al OCR con detalle suficiente, sea cual sea su tamaño.
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.max(1.5, targetLongSide / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport }).promise;
      images[pageNum - 1] = canvas.toDataURL("image/jpeg", 0.92);
      page.cleanup();
      onProgress?.(++hechas, pdf.numPages);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGINAS_A_LA_VEZ, pdf.numPages) }, trabajador));

  pdf.destroy();
  // Una página que no se pudo dibujar se omite, como antes.
  return images.filter(Boolean);
}
