// Localiza la zona útil de una ficha de asistencia (renglones + columnas de nombre y DNI)
// con visión clásica, para enviarle al modelo solo esa zona.
//
// Por qué: Gemini reparte un presupuesto FIJO de tokens por imagen. En la hoja completa,
// logos, datos del empleador, firmas y observaciones se llevan dos tercios de ese
// presupuesto y a cada dígito manuscrito le toca muy poco. Medido sobre 100 renglones:
// con la hoja completa se resolvían 63-67 contra la maestra; con el recorte, 74.
//
// REGLA: ante la duda, no recortar. Un recorte equivocado deja participantes fuera sin
// que nadie se entere; la hoja completa solo lee algo peor. Todas las comprobaciones de
// abajo devuelven null (= enviar la hoja entera) si la tabla no se reconoce con claridad.

/** Rectángulo en fracciones 0-1 de la imagen original. */
export interface Zona { x0: number; y0: number; x1: number; y1: number }

/**
 * Geometría de los renglones medida sobre las líneas impresas, en fracciones 0-1 de la
 * página: centro del primer y del último renglón, bordes de la tabla y cuántos renglones
 * hay. Es exacta, cosa que las coordenadas que devuelve el modelo no son (para una misma
 * tabla, cuatro modelos dieron cuatro centros distintos y uno copió los del ejemplo).
 */
export interface Renglones { yPrimera: number; yUltima: number; xIzq: number; xDer: number; total: number }

export interface TablaDetectada { zona: Zona; renglones: Renglones }

interface Linea { pos: number; ini: number; fin: number } // en píxeles de la miniatura

const ANCHO_ANALISIS = 900;      // la detección corre sobre una miniatura: sobra y es rápida
const UMBRAL_OSCURO = 150;
const MIN_RENGLONES = 8;         // menos que esto no es una lista de asistencia reconocible
const TOLERANCIA_ALTURA = 0.18;  // los renglones impresos miden todos lo mismo

/** Agrupa posiciones consecutivas marcadas como línea y devuelve el centro de cada grupo. */
function agrupar(marcas: Uint8Array, ini: Int32Array, fin: Int32Array): Linea[] {
  const lineas: Linea[] = [];
  let i = 0;
  while (i < marcas.length) {
    if (!marcas[i]) { i++; continue; }
    let j = i, a = ini[i], b = fin[i];
    while (j + 1 < marcas.length && marcas[j + 1]) { j++; a = Math.min(a, ini[j]); b = Math.max(b, fin[j]); }
    lineas.push({ pos: (i + j) / 2, ini: a, fin: b });
    i = j + 1;
  }
  return lineas;
}

const mediana = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Devuelve la zona a recortar, o null si no hay una tabla de renglones reconocible.
 * `fuente` es la página ya dibujada (canvas o imagen) a cualquier resolución.
 */
export function detectarZonaTabla(fuente: CanvasImageSource, anchoFuente: number, altoFuente: number): TablaDetectada | null {
  try {
    if (!anchoFuente || !altoFuente) return null;
    const W = Math.min(ANCHO_ANALISIS, anchoFuente);
    const H = Math.max(1, Math.round((altoFuente * W) / anchoFuente));
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(fuente, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;

    const oscuro = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      oscuro[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2] < UMBRAL_OSCURO ? 1 : 0;
    }

    // --- Líneas horizontales ---------------------------------------------------
    // Una línea de tabla es un tramo oscuro LARGO y continuo; un renglón de texto tiene
    // mucha tinta pero a trozos. Se mira también el píxel de arriba y el de abajo para
    // tolerar un escaneo ligeramente inclinado, y se perdonan cortes de pocos píxeles.
    const HUECO = 4;
    const esLineaH = new Uint8Array(H), iniH = new Int32Array(H), finH = new Int32Array(H);
    for (let y = 1; y < H - 1; y++) {
      let mejor = 0, mejorIni = 0, ini = -1, hueco = 0;
      for (let x = 0; x <= W; x++) {
        const tinta = x < W && (oscuro[y * W + x] || oscuro[(y - 1) * W + x] || oscuro[(y + 1) * W + x]);
        if (tinta) { if (ini < 0) ini = x; hueco = 0; }
        else if (ini >= 0 && ++hueco > HUECO || (x === W && ini >= 0)) {
          const fin = x - hueco;
          if (fin - ini > mejor) { mejor = fin - ini; mejorIni = ini; }
          ini = -1; hueco = 0;
        }
      }
      if (mejor >= W * 0.5) { esLineaH[y] = 1; iniH[y] = mejorIni; finH[y] = mejorIni + mejor; }
    }
    const lineas = agrupar(esLineaH, iniH, finH);
    if (lineas.length < MIN_RENGLONES + 1) return null;

    // --- La racha más larga de líneas equiespaciadas = los renglones de datos ------
    let mejorRacha: Linea[] = [];
    for (let a = 0; a < lineas.length - 1; a++) {
      const paso = lineas[a + 1].pos - lineas[a].pos;
      if (paso < H * 0.012) continue; // demasiado juntas para ser renglones manuscritos
      let b = a + 1;
      while (b + 1 < lineas.length && Math.abs(lineas[b + 1].pos - lineas[b].pos - paso) <= paso * TOLERANCIA_ALTURA) b++;
      if (b - a + 1 > mejorRacha.length) mejorRacha = lineas.slice(a, b + 1);
    }
    if (mejorRacha.length < MIN_RENGLONES + 1) return null;

    const pasos = mejorRacha.slice(1).map((l, i) => l.pos - mejorRacha[i].pos);
    const alto = mediana(pasos);
    // Bordes de la tabla: la línea que más se extiende a cada lado, no la mediana. En un
    // escaneo flojo varias líneas llegan cortadas por la izquierda, y recortar por la
    // mediana se comía la columna de números de renglón. Pasarse de ancho no cuesta nada.
    const izq = Math.min(...mejorRacha.map((l) => l.ini));
    const der = Math.max(...mejorRacha.map((l) => l.fin));
    const arriba = mejorRacha[0].pos;
    let abajo = mejorRacha[mejorRacha.length - 1].pos;
    const renglones: Renglones = {
      yPrimera: (arriba + alto / 2) / H,
      yUltima: (abajo - alto / 2) / H,
      xIzq: izq / W,
      xDer: der / W,
      total: mejorRacha.length - 1,
    };

    // Hacia abajo se siguen incluyendo líneas mientras estén a una distancia de "renglón"
    // (0.4-2.5 alturas): cubre un último renglón más alto o partido. Cuesta incluir algo
    // del pie de la ficha, pero nunca deja un participante fuera.
    for (const l of lineas) {
      if (l.pos <= abajo) continue;
      const salto = l.pos - abajo;
      if (salto < alto * 0.4 || salto > alto * 2.5) break;
      abajo = l.pos;
    }

    // --- Columna de DNI: una ristra de casillas estrechas e iguales --------------
    // Si existe, todo lo que queda a su derecha (ocupación, área, firma, observaciones)
    // no se usa y se recorta. Si no se reconoce, se conserva la tabla a todo lo ancho.
    const y0b = Math.round(arriba), y1b = Math.round(mejorRacha[mejorRacha.length - 1].pos);
    const altoBanda = Math.max(1, y1b - y0b);
    const esLineaV = new Uint8Array(W), nada = new Int32Array(W);
    for (let x = 1; x < W - 1; x++) {
      let n = 0;
      for (let y = y0b; y < y1b; y++) {
        if (oscuro[y * W + x] || oscuro[y * W + x - 1] || oscuro[y * W + x + 1]) n++;
      }
      if (n >= altoBanda * 0.75) esLineaV[x] = 1;
    }
    const verticales = agrupar(esLineaV, nada, nada).map((l) => l.pos).filter((x) => x >= izq - 3 && x <= der + 3);

    let derechaUtil = der;
    const anchoTabla = der - izq;
    for (let a = 0; a < verticales.length - 1; a++) {
      const paso = verticales[a + 1] - verticales[a];
      if (paso > W * 0.035 || paso < W * 0.008) continue; // casilla de un dígito
      let b = a + 1;
      while (b + 1 < verticales.length && Math.abs(verticales[b + 1] - verticales[b] - paso) <= paso * 0.35) b++;
      // 7 casillas seguidas o más, y con sitio a su izquierda para la columna de nombres.
      if (b - a >= 7 && verticales[a] - izq >= anchoTabla * 0.25) {
        // Se deja un margen de dos casillas: basta para ver el borde de la última.
        derechaUtil = Math.min(der, verticales[b] + paso * 2);
        break;
      }
      a = b - 1;
    }

    const zona: Zona = {
      x0: Math.max(0, (izq - W * 0.012) / W),
      x1: Math.min(1, (derechaUtil + W * 0.012) / W),
      // Margen superior de 1.6 renglones: entra la fila de títulos ("Apellidos y nombres",
      // "N° DNI"), que le dice al modelo qué es cada columna, y un primer renglón algo más alto.
      y0: Math.max(0, (arriba - alto * 1.6) / H),
      y1: Math.min(1, (abajo + alto * 0.5) / H),
    };

    // Si casi no se quita nada, no merece la pena introducir un sistema de coordenadas más.
    if ((zona.x1 - zona.x0) * (zona.y1 - zona.y0) > 0.85) return null;
    return { zona, renglones };
  } catch (err) {
    console.warn("No se pudo localizar la tabla; se envía la hoja completa:", err);
    return null;
  }
}
