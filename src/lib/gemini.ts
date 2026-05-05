import { GoogleGenerativeAI } from "@google/generative-ai";
import { EXTRACTION_PROMPT as PROMPT, GEMINI_MODELS as MODELS } from "@/config";

export interface ProcessedResult {
  csv: string;
  modelUsed: string;
}

export async function processDocuments(files: { data: string; mimeType: string; name: string }[]): Promise<ProcessedResult> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno VITE_GEMINI_API_KEY.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const parts: any[] = [];
  files.forEach((file, index) => {
    parts.push({ text: `Archivo ${index + 1}: ${file.name}` });
    parts.push({
      inlineData: {
        data: file.data,
        mimeType: file.mimeType,
      },
    });
  });

  parts.push({
    text: "Extrae la información de las tablas en estos documentos siguiendo estrictamente el formato CSV requerido. Es CRITICO que en la columna 'SourceFile' coloques exactamente el nombre del archivo (ej. A1.jpeg) de donde proviene cada fila.",
  });

  let lastError: any;
  const triedModels: string[] = [];

  for (const modelName of MODELS) {
    try {
      console.log(`Intentando extracción con el modelo: ${modelName}`);
      triedModels.push(modelName);
      
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: PROMPT 
      });

      const result = await model.generateContent(parts);
      const response = await result.response;
      let text = response.text();

      if (!text) throw new Error("Respuesta vacía del modelo.");

      text = text.replace(/^```(csv|txt)?\n/i, "");
      text = text.replace(/\n```$/i, "");
      text = text.trim();

      if (!text.toLowerCase().includes("sourcefile")) {
         text = "Nro;Apellidos y Nombres;DNI;Ocupacion;Area;SourceFile\n" + text;
      }

      console.log(`¡Éxito con el modelo ${modelName}!`);
      return {
        csv: text,
        modelUsed: modelName,
      };
    } catch (error: any) {
      console.error(`Error con el modelo ${modelName}:`, error);
      lastError = error;
    }
  }

  throw new Error(`Fallaron todos los modelos intentados (${triedModels.join(", ")}). Último error: ${lastError?.message || String(lastError)}`);
}
