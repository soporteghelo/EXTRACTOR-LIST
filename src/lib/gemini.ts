import { PartMediaResolutionLevel, Type, type Part } from "@google/genai";
import { EXTRACTION_PROMPT as PROMPT, GEMINI_MODELS as MODELS } from "@/config";
import type { RecorteFila } from "./rowCrop";

export interface ProcessedResult {
  csv: string;
  modelUsed: string;
}

const CABECERA_CSV =
  "Nro;Apellidos y Nombres;DNI;Ocupacion;Area;SourceFile;FilaDoc;Pagina;RowAnchors;TotalFilas";

// Presupuesto de salida. No es un límite que queramos alcanzar, es una red: sin él, una
// lista larga se puede truncar a mitad del CSV y la app acepta los datos parciales como
// si la extracción hubiera ido bien. Con él, la truncación se detecta (finishReason) y
// se convierte en error visible. Holgado a propósito para que también quepa el
// razonamiento interno del modelo sin comerse la respuesta.
const MAX_OUTPUT_TOKENS = 32768;

// Vercel rechaza (413) cualquier petición a una función que pase de 4.5 MB. Se comprueba
// antes de enviar, con algo de margen, para dar un mensaje útil en vez de un fallo opaco;
// y se aplica también en local para que lo que funciona aquí funcione desplegado.
const LIMITE_PETICION_BYTES = 4.3 * 1024 * 1024;

// Que un envío no quepa no depende del modelo: se marca para no reintentarlo con los
// cinco modelos de la lista y cortar en seco con el mensaje útil.
class ErrorTamano extends Error {}

interface RespuestaGemini {
  text: string;
  finishReason: string | null;
}

/**
 * Llama a Gemini a través de /api/gemini (api/gemini.ts). La API key vive solo en el
 * servidor: el navegador nunca la ve, así que no se puede copiar de la web desplegada.
 */
async function llamarGemini(peticion: {
  model: string;
  contents: Part[];
  config: Record<string, unknown>;
}): Promise<RespuestaGemini> {
  const cuerpo = JSON.stringify(peticion);
  if (cuerpo.length > LIMITE_PETICION_BYTES) {
    const mb = (cuerpo.length / 1024 / 1024).toFixed(1);
    throw new ErrorTamano(
      `Una sola página pesa ${mb} MB y el servidor admite hasta 4.5 MB por envío. Prueba con una imagen de menor resolución.`
    );
  }

  const res = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: cuerpo,
  });
  // Vercel responde algunos fallos (413, timeout) con texto plano, no con JSON.
  const datos = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 413) {
      throw new ErrorTamano("El envío es demasiado grande para el servidor (límite de 4.5 MB).");
    }
    throw new Error(datos?.error || `El servidor respondió ${res.status}.`);
  }
  return { text: datos?.text ?? "", finishReason: datos?.finishReason ?? null };
}

/** La interfaz lo usa para avisar si falta la clave, sin llegar a conocerla. */
export async function claveConfigurada(): Promise<boolean> {
  try {
    const res = await fetch("/api/gemini");
    const datos = await res.json();
    return !!datos?.configurada;
  } catch {
    return false;
  }
}

// La resolución por parte solo existe en Gemini 3; en modelos anteriores el campo
// provoca un error de petición, así que se omite y se acepta la resolución por defecto.
function soportaResolucionPorParte(modelName: string): boolean {
  return /^gemini-3/.test(modelName);
}

/**
 * Construye las partes de la petición. Cada imagen se envía con la etiqueta de su
 * archivo delante para que el modelo pueda rellenar SourceFile sin inventárselo.
 *
 * ULTRA_HIGH es el punto clave para manuscrita: Gemini reparte un presupuesto fijo de
 * tokens por imagen (1120 por defecto, y solo 560 en PDF). Una A4 con 20 filas deja a
 * cada dígito escrito a mano una fracción minúscula de ese presupuesto; ULTRA_HIGH lo
 * dobla a 2240 y es justo el detalle fino donde hoy se pierden lecturas.
 */
function construirPartes(
  files: ArchivoEntrada[],
  conResolucionAlta: boolean
): Part[] {
  const parts: Part[] = [];

  files.forEach((file, index) => {
    parts.push({ text: `Archivo ${index + 1}: ${file.name}` });
    const imagen: Part = {
      inlineData: { data: file.data, mimeType: file.mimeType },
    };
    if (conResolucionAlta) {
      imagen.mediaResolution = {
        level: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH,
      };
    }
    parts.push(imagen);
  });

  parts.push({
    text: "Extrae la información de las tablas en estos documentos siguiendo estrictamente el formato CSV requerido. Es CRITICO que en la columna 'SourceFile' coloques exactamente el nombre del archivo (ej. A1.jpeg) de donde proviene cada fila, en 'FilaDoc' el número de renglón físico (de arriba hacia abajo, empezando en 1, sin contar la cabecera), en 'Pagina' el número de página (empezando en 1), en 'RowAnchors' los 4 enteros 'yCentroPrimera,xIzquierda,yCentroUltima,xDerecha' (0-1000): el centro vertical del PRIMER y del ÚLTIMO renglón de datos y los bordes izquierdo/derecho de la tabla (idéntico para toda la página), y en 'TotalFilas' el número del último renglón físico (idéntico para toda la página). Apunta los centros con precisión: de ellos depende que la marca caiga exactamente sobre la fila correcta.",
  });

  return parts;
}

export interface ArchivoEntrada {
  data: string;
  mimeType: string;
  name: string;
  /** Página real dentro del documento (1-based). Solo para PDFs de varias hojas. */
  pagina?: number;
}

// Presupuesto por envío para el reparto en lotes. Por debajo del límite duro (4.3 MB) para
// dejar sitio a las etiquetas, el prompt del sistema y el envoltorio JSON.
const PRESUPUESTO_LOTE_BYTES = 3.8 * 1024 * 1024;

/**
 * Parte las páginas en lotes contiguos que quepan en un envío. Se busca el MENOR número
 * de lotes, y de tamaño parejo (no "llenar el primero y el resto al último"): así cada
 * llamada tarda parecido y, al ir en paralelo, el total lo marca el lote más lento.
 *
 * Parejo y contiguo también garantiza que los lotes 2.º en adelante empiezan en una
 * página mayor que el tamaño de cualquier lote; renumerarPaginas se apoya en eso.
 */
function repartirEnLotes(files: ArchivoEntrada[]): ArchivoEntrada[][] {
  const peso = (f: ArchivoEntrada) => f.data.length;
  const total = files.reduce((acc, f) => acc + peso(f), 0);
  for (let k = Math.max(1, Math.ceil(total / PRESUPUESTO_LOTE_BYTES)); k <= files.length; k++) {
    const porLote = Math.ceil(files.length / k);
    const lotes: ArchivoEntrada[][] = [];
    for (let i = 0; i < files.length; i += porLote) lotes.push(files.slice(i, i + porLote));
    if (lotes.every((l) => l.reduce((acc, f) => acc + peso(f), 0) <= PRESUPUESTO_LOTE_BYTES)) {
      return lotes;
    }
  }
  return files.map((f) => [f]); // una página por envío; si aun así no cabe, llamarGemini avisa
}

/**
 * Deja la columna Pagina con el número de hoja REAL del documento. Dentro de un lote el
 * modelo puede numerar desde 1 (la 6.ª hoja del PDF es la 2.ª imagen que ve), y el visor
 * abriría entonces la hoja equivocada.
 *
 *  1. Si SourceFile coincide con la etiqueta de una imagen del lote, manda esa etiqueta.
 *  2. Si no, un número que ya es una página del lote se respeta (vino en absoluto).
 *  3. Si no, se lee como posición dentro del lote (vino en relativo).
 */
function renumerarPaginas(lineas: string[], lote: ArchivoEntrada[]): string[] {
  const paginas = lote.map((f) => f.pagina);
  if (paginas.some((p) => p === undefined)) return lineas; // imagen suelta: nada que hacer
  const porEtiqueta = new Map(lote.map((f) => [f.name.trim().toLowerCase(), f.pagina!]));
  const delLote = new Set(paginas as number[]);

  return lineas.map((linea) => {
    const cols = linea.split(";");
    if (cols.length < 8) return linea;
    const n = parseInt(cols[7], 10);
    const real =
      porEtiqueta.get(cols[5].trim().toLowerCase()) ??
      (delLote.has(n) ? n : n >= 1 && n <= lote.length ? lote[n - 1].pagina : undefined);
    if (real !== undefined) cols[7] = String(real);
    return cols.join(";");
  });
}

/**
 * Extrae un documento. Un PDF de muchas hojas no cabe en un solo envío (límite de 4.5 MB
 * de Vercel: 7 hojas ya lo pasan), así que se reparte en lotes que se procesan en
 * paralelo y se unen en un único CSV. Cada hoja de estas fichas es independiente, así que
 * partir entre hojas no le quita al modelo contexto que necesite.
 */
export async function processDocuments(files: ArchivoEntrada[]): Promise<ProcessedResult> {
  const lotes = repartirEnLotes(files);
  if (lotes.length > 1) {
    console.log(`Documento repartido en ${lotes.length} envíos: ${lotes.map((l) => l.length).join(" + ")} páginas.`);
  }

  const resultados = await Promise.all(lotes.map((lote) => extraerLote(lote)));

  const filas = resultados.flatMap((r, i) =>
    renumerarPaginas(
      r.csv.split("\n").filter((l) => l.trim() && !l.toLowerCase().includes("sourcefile")),
      lotes[i]
    )
  );
  const csv = [CABECERA_CSV, ...filas].join("\n");
  if (lotes.length > 1) console.log("=== CSV unido de todos los envíos ===\n" + csv);

  return {
    csv,
    modelUsed: [...new Set(resultados.map((r) => r.modelUsed))].join(" + "),
  };
}

async function extraerLote(files: ArchivoEntrada[]): Promise<ProcessedResult> {
  let lastError: any;
  const triedModels: string[] = [];

  for (const modelName of MODELS) {
    try {
      console.log(`Intentando extracción con el modelo: ${modelName}`);
      triedModels.push(modelName);

      const response = await llamarGemini({
        model: modelName,
        contents: construirPartes(files, soportaResolucionPorParte(modelName)),
        config: {
          systemInstruction: PROMPT,
          // Transcribir es una tarea determinista: a temperatura por defecto (1.0) el
          // mismo documento podía dar dos lecturas distintas en dos ejecuciones.
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });

      if (response.finishReason === "MAX_TOKENS") {
        throw new Error(
          "La respuesta se cortó por longitud: el documento tiene más filas de las que caben en una sola pasada."
        );
      }

      let text = response.text;
      if (!text) throw new Error("Respuesta vacía del modelo.");

      text = text.replace(/^```(csv|txt)?\n/i, "");
      text = text.replace(/\n```$/i, "");
      text = text.trim();

      if (!text.toLowerCase().includes("sourcefile")) {
        text = CABECERA_CSV + "\n" + text;
      }

      console.log(`¡Éxito con el modelo ${modelName}!`);
      // Respuesta cruda a la consola: cuando una extracción sale mal, es la única
      // forma de distinguir si el modelo leyó mal el documento o si el fallo está
      // en cómo la app interpreta el CSV.
      console.log("=== CSV devuelto por el modelo ===\n" + text);
      return {
        csv: text,
        modelUsed: modelName,
      };
    } catch (error: any) {
      if (error instanceof ErrorTamano) throw error;
      console.error(`Error con el modelo ${modelName}:`, error);
      lastError = error;
    }
  }

  throw new Error(
    `Fallaron todos los modelos intentados (${triedModels.join(", ")}). Último error: ${lastError?.message || String(lastError)}`
  );
}

// ---------------------------------------------------------------------------
// Relectura puntual (Fase 4): último recurso, solo sobre filas sin coincidencia
// ---------------------------------------------------------------------------

export interface LecturaFila {
  id: string;
  dni: string;
  nombre: string;
  confianza: number;
}

// ULTRA_HIGH solo existe en Gemini 3, y sin él esta pasada pierde su razón de ser
// (todo el punto es darle a un solo renglón el presupuesto de tokens de una hoja entera).
const MODELOS_RELECTURA = MODELS.filter((m) => /^gemini-3/.test(m));

const ESQUEMA_RELECTURA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "El identificador que acompaña a la imagen." },
      dni: { type: Type.STRING, description: "Los 8 dígitos del DNI, sin espacios. Cadena vacía si es ilegible." },
      nombre: { type: Type.STRING, description: "Apellidos y nombres tal como están escritos." },
      confianza: { type: Type.NUMBER, description: "0 a 1: certeza de la lectura del DNI." },
    },
    required: ["id", "dni", "nombre", "confianza"],
  },
};

const PROMPT_RELECTURA = `Eres un lector experto de formularios manuscritos. Cada imagen es UN ÚNICO renglón recortado de una ficha de asistencia peruana, ampliado al máximo.

Tu tarea: leer el DNI (8 dígitos) y el nombre de cada renglón.

Reglas:
- Mira dígito por dígito. Las confusiones típicas en manuscrita son 1/7, 4/9, 3/8, 5/6, 0/6 y 2/7: decide por la forma del trazo, no por lo que "suele" ser.
- Si el renglón está tachado o vacío, devuelve dni y nombre vacíos con confianza 0.
- NO inventes. Si un dígito es indescifrable, devuelve el DNI vacío y baja la confianza.
- La confianza debe ser honesta: 1.0 solo si los 8 dígitos son inequívocos.
- Transcribe el nombre tal cual está escrito, sin corregir ortografía.`;

/**
 * Relee un puñado de renglones recortados. Es la ÚNICA llamada extra a la IA del
 * pipeline y solo debe dispararse cuando el matching local no encontró coincidencia:
 * en un documento típico son 1-3 renglones, no los 20.
 *
 * `candidatos` es la lista de personas plausibles sacada de la maestra. Dársela al
 * modelo convierte el problema de "leer 8 dígitos cualesquiera" en "elegir entre un
 * conjunto conocido", que es muchísimo más fácil: un 4 que parece un 9 se resuelve solo
 * si únicamente una de las dos opciones existe en la lista. Aun así se le permite
 * responder algo que no esté en ella, para no forzar a nadie a una identidad ajena.
 */
export async function releerFilas(
  recortes: RecorteFila[],
  candidatos: { dni: string; nombre: string }[]
): Promise<{ lecturas: LecturaFila[]; modelUsed: string }> {
  if (recortes.length === 0) return { lecturas: [], modelUsed: "" };

  if (MODELOS_RELECTURA.length === 0) {
    throw new Error("La relectura necesita un modelo Gemini 3 en GEMINI_MODELS.");
  }

  const parts: Part[] = [];
  recortes.forEach((r) => {
    parts.push({ text: `Renglón id=${r.id}:` });
    parts.push({
      inlineData: { data: r.base64, mimeType: r.mimeType },
      mediaResolution: { level: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH },
    });
  });

  if (candidatos.length > 0) {
    parts.push({
      text:
        `Estas son las personas que podrían aparecer en estos renglones (DNI — nombre). ` +
        `Si tu lectura coincide razonablemente con una de ellas, devuelve el DNI de la lista. ` +
        `Si no se parece a ninguna, devuelve lo que realmente ves.\n\n` +
        candidatos.map((c) => `${c.dni} — ${c.nombre}`).join("\n"),
    });
  }

  parts.push({
    text: `Devuelve un objeto por cada renglón, usando exactamente el id que lo acompaña. Son ${recortes.length} renglones.`,
  });

  let lastError: any;
  for (const modelName of MODELOS_RELECTURA) {
    try {
      const response = await llamarGemini({
        model: modelName,
        contents: parts,
        config: {
          systemInstruction: PROMPT_RELECTURA,
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
          responseSchema: ESQUEMA_RELECTURA,
        },
      });

      if (response.finishReason === "MAX_TOKENS") {
        throw new Error("La relectura se cortó por longitud.");
      }
      const text = response.text;
      if (!text) throw new Error("Respuesta vacía del modelo.");

      const lecturas = JSON.parse(text) as LecturaFila[];
      console.log(`=== Relectura (${modelName}) ===`, lecturas);
      return { lecturas, modelUsed: modelName };
    } catch (error: any) {
      if (error instanceof ErrorTamano) throw error;
      console.error(`Relectura fallida con ${modelName}:`, error);
      lastError = error;
    }
  }

  throw new Error(`No se pudo releer. Último error: ${lastError?.message || String(lastError)}`);
}
