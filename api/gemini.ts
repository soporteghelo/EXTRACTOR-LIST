// Función de servidor (Vercel) que habla con Gemini en nombre del navegador.
//
// Existe para que la API key NUNCA llegue al navegador. Antes la clave iba como
// VITE_GEMINI_API_KEY, y Vite mete toda variable VITE_* dentro del JavaScript público:
// cualquiera podía copiarla de la web desplegada, y Google la terminó suspendiendo.
// Aquí se lee GEMINI_API_KEY (sin prefijo VITE_), que solo existe en el servidor.
//
// El mismo handler sirve en local: vite.config.ts lo monta como middleware en /api/gemini.
// Por eso solo usa la API básica de Node (statusCode / setHeader / end) y lee el cuerpo
// él mismo si nadie lo ha parseado antes.
//
// Este archivo es autocontenido a propósito: con "type": "module", Vercel ejecuta las
// funciones como ESM y un import relativo sin extensión rompe en producción.

import type { IncomingMessage, ServerResponse } from "node:http";
import { GoogleGenAI } from "@google/genai";

// Red de seguridad contra el abuso del endpoint: solo modelos Gemini y con un techo de
// salida. La app nunca pide más que esto (ver MAX_OUTPUT_TOKENS en src/lib/gemini.ts).
const MODELO_VALIDO = /^gemini-[\w.-]+$/;
const TECHO_TOKENS_SALIDA = 32768;

function claveServidor(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

function responder(res: ServerResponse, status: number, cuerpo: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(cuerpo));
}

async function leerCuerpo(req: IncomingMessage): Promise<any> {
  // Vercel ya entrega req.body parseado; el servidor de desarrollo de Vite no.
  const yaParseado = (req as any).body;
  if (yaParseado !== undefined) {
    return typeof yaParseado === "string" ? JSON.parse(yaParseado) : yaParseado;
  }
  const trozos: Buffer[] = [];
  for await (const trozo of req) trozos.push(trozo as Buffer);
  return JSON.parse(Buffer.concat(trozos).toString("utf8") || "{}");
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // GET: la interfaz solo pregunta si la clave está configurada, nunca la recibe.
  if (req.method === "GET") {
    return responder(res, 200, { configurada: !!claveServidor() });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return responder(res, 405, { error: "Método no permitido." });
  }

  const apiKey = claveServidor();
  if (!apiKey) {
    return responder(res, 500, {
      error: "Falta la variable de entorno GEMINI_API_KEY en el servidor.",
    });
  }

  let cuerpo: any;
  try {
    cuerpo = await leerCuerpo(req);
  } catch {
    return responder(res, 400, { error: "El cuerpo de la petición no es JSON válido." });
  }

  const { model, contents, config } = cuerpo ?? {};
  if (typeof model !== "string" || !MODELO_VALIDO.test(model)) {
    return responder(res, 400, { error: "Modelo no permitido." });
  }
  if (!Array.isArray(contents) || contents.length === 0) {
    return responder(res, 400, { error: "La petición no trae contenido." });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        ...(config ?? {}),
        maxOutputTokens: Math.min(Number(config?.maxOutputTokens) || TECHO_TOKENS_SALIDA, TECHO_TOKENS_SALIDA),
      },
    });
    return responder(res, 200, {
      text: response.text ?? "",
      finishReason: response.candidates?.[0]?.finishReason ?? null,
    });
  } catch (error: any) {
    // Se reenvía el error de Google tal cual (403 clave suspendida, 404 modelo retirado,
    // 429 cuota...): el cliente prueba el siguiente modelo y, si todos fallan, lo muestra.
    const status = Number(error?.status) >= 400 ? Number(error.status) : 502;
    return responder(res, status, { error: error?.message || String(error) });
  }
}
