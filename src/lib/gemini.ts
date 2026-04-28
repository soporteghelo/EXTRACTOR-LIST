import { GoogleGenAI } from "@google/genai";
import { EXTRACTION_PROMPT as PROMPT, GEMINI_MODELS as MODELS } from "@/config";

export interface ProcessedResult {
  csv: string;
  modelUsed: string;
}

export async function processDocuments(files: { data: string; mimeType: string; name: string }[]): Promise<ProcessedResult> {
  // Usar el estándar de Vite para variables de entorno
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno VITE_GEMINI_API_KEY. Configúrala en tu archivo .env o en Vercel.");
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

      // Compatibilidad con diferentes estructuras de respuesta
      let text = "";
      if (response.text) {
        text = response.text;
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text;
      } else {
        throw new Error("No se pudo obtener el texto de la respuesta de Gemini");
      }

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
