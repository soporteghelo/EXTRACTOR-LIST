import { GoogleGenAI } from "@google/genai";
import { EXTRACTION_PROMPT as PROMPT, GEMINI_MODELS as MODELS } from "@/src/config";

export interface ProcessedResult {
  csv: string;
  modelUsed: string;
}

export async function processDocuments(files: { data: string; mimeType: string; name: string }[]): Promise<ProcessedResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const ai = new GoogleGenAI({ apiKey });

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

  for (const model of MODELS) {
    try {
      console.log(`Intentando con el modelo: ${model}`);
      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          systemInstruction: PROMPT,
          temperature: 0.1, 
        },
      });

      let text = response.text || "";
      text = text.replace(/^```(csv|txt)?\n/i, "");
      text = text.replace(/\n```$/i, "");
      text = text.trim();

      // Ensure headers are present with the SourceFile column
      if (!text.toLowerCase().includes("sourcefile")) {
         text = "Nro;Apellidos y Nombres;DNI;Ocupacion;Area;SourceFile\n" + text;
      }

      return {
        csv: text,
        modelUsed: model,
      };
    } catch (error) {
      console.error(`Modelo ${model} falló:`, error);
      lastError = error;
    }
  }

  throw new Error("Todos los modelos fallaron. Último error: " + (lastError?.message || String(lastError)));
}
