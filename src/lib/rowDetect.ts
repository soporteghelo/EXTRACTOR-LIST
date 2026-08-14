// Detección de los renglones reales de una tabla a partir de sus líneas horizontales.
// Esto ancla la marca al grid real del documento, sin depender de la precisión de la IA.

export interface RowBand { top: number; bottom: number } // fracciones 0-1 respecto al alto de la imagen

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Detecta las bandas (renglones) de la franja de datos de una tabla buscando sus
 * líneas horizontales ruled dentro del rango horizontal indicado.
 *
 * @param xMinFrac/xMaxFrac  rango horizontal de la tabla (fracción 0-1)
 * @param expectedRows       número aproximado de renglones de datos (para validar)
 * @returns array de bandas (renglón 1 = índice 0) o null si no se pudo detectar.
 */
export async function detectDataRowBands(
  imageUrl: string,
  xMinFrac: number,
  xMaxFrac: number,
  expectedRows: number
): Promise<RowBand[] | null> {
  try {
    const img = await loadImage(imageUrl);
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) return null;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);

    const x0 = Math.max(0, Math.floor((xMinFrac || 0) * W));
    const x1 = Math.min(W, Math.ceil((xMaxFrac || 1) * W));
    const bandW = Math.max(1, x1 - x0);
    const data = ctx.getImageData(x0, 0, bandW, H).data;

    // Proporción de píxeles oscuros por cada fila de píxeles (una línea ruled es oscura a lo ancho).
    const dark = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let cnt = 0;
      const rowOff = y * bandW * 4;
      for (let x = 0; x < bandW; x++) {
        const i = rowOff + x * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 145) cnt++;
      }
      dark[y] = cnt / bandW;
    }

    // Detectar las posiciones (centroides) de las líneas horizontales.
    const TH = 0.45; // una línea cubre >45% del ancho de la tabla
    const lines: number[] = [];
    let y = 0;
    while (y < H) {
      if (dark[y] > TH) {
        const yStart = y;
        while (y < H && dark[y] > TH) y++;
        lines.push((yStart + (y - 1)) / 2);
      } else {
        y++;
      }
    }
    if (lines.length < 3) return null;

    // Gaps entre líneas consecutivas.
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);

    // Buscar la racha más larga de gaps casi uniformes: ese es el grid de participantes
    // (la cabecera/secciones superiores tienen renglones de alturas irregulares).
    const within = (a: number, b: number) => Math.abs(a - b) <= 0.35 * Math.max(a, b);
    let bestStart = 0, bestLen = 0;
    let i = 0;
    while (i < gaps.length) {
      let j = i;
      while (j + 1 < gaps.length && within(gaps[j + 1], gaps[i])) j++;
      const len = j - i + 1;
      if (len > bestLen) { bestLen = len; bestStart = i; }
      i = j + 1;
    }
    if (bestLen < 2) return null;

    // gridLines: bestLen+1 líneas → bestLen bandas (renglones).
    const gridLines = lines.slice(bestStart, bestStart + bestLen + 1);
    const bands: RowBand[] = [];
    for (let k = 1; k < gridLines.length; k++) {
      bands.push({ top: gridLines[k - 1] / H, bottom: gridLines[k] / H });
    }
    if (!bands.length) return null;

    // Validación: si el número de bandas es absurdamente distinto al esperado, desconfiar.
    if (expectedRows > 0 && bands.length < Math.max(2, Math.floor(expectedRows * 0.4))) {
      return null;
    }
    return bands;
  } catch {
    return null;
  }
}
