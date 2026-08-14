import { GoogleGenAI, PartMediaResolutionLevel, Type, type Part } from "@google/genai";
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
  files: { data: string; mimeType: string; name: string }[],
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

export async function processDocuments(
  files: { data: string; mimeType: string; name: string }[]
): Promise<ProcessedResult> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno VITE_GEMINI_API_KEY.");
  }

  const ai = new GoogleGenAI({ apiKey });

  let lastError: any;
  const triedModels: string[] = [];

  for (const modelName of MODELS) {
    try {
      console.log(`Intentando extracción con el modelo: ${modelName}`);
      triedModels.push(modelName);

      const response = await ai.models.generateContent({
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

      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === "MAX_TOKENS") {
        throw new Error(
          "La respuesta se cortó por longitud: el documento tiene más filas de las que caben en una sola pasada. Divide el lote en menos archivos."
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

  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Falta la variable de entorno VITE_GEMINI_API_KEY.");
  if (MODELOS_RELECTURA.length === 0) {
    throw new Error("La relectura necesita un modelo Gemini 3 en GEMINI_MODELS.");
  }

  const ai = new GoogleGenAI({ apiKey });

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
      const response = await ai.models.generateContent({
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

      if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        throw new Error("La relectura se cortó por longitud.");
      }
      const text = response.text;
      if (!text) throw new Error("Respuesta vacía del modelo.");

      const lecturas = JSON.parse(text) as LecturaFila[];
      console.log(`=== Relectura (${modelName}) ===`, lecturas);
      return { lecturas, modelUsed: modelName };
    } catch (error: any) {
      console.error(`Relectura fallida con ${modelName}:`, error);
      lastError = error;
    }
  }

  throw new Error(`No se pudo releer. Último error: ${lastError?.message || String(lastError)}`);
}
