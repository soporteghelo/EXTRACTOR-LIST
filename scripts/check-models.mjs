/**
 * Comprueba qué modelos de GEMINI_MODELS existen de verdad en la API.
 *
 * El catálogo de Gemini se mueve rápido y los modelos retirados no avisan: la lista
 * anterior empezaba por `gemini-2.0-flash`, apagado, así que cada extracción quemaba
 * una petición fallida antes de dar con uno vivo. Este script detecta esa situación
 * sin tener que abrir la app.
 *
 *   VITE_GEMINI_API_KEY=xxx node scripts/check-models.mjs
 *   (o con un .env en la raíz)
 */
import { readFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";

function leerClave() {
  if (process.env.VITE_GEMINI_API_KEY) return process.env.VITE_GEMINI_API_KEY;
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    return /^VITE_GEMINI_API_KEY\s*=\s*(.+)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

// Se leen del config real para que el script no pueda quedar desincronizado.
const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const bloque = /export const GEMINI_MODELS = \[([\s\S]*?)\]/.exec(config)?.[1] ?? "";
const modelos = [...bloque.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const apiKey = leerClave();
if (!apiKey) {
  console.error("Falta VITE_GEMINI_API_KEY (variable de entorno o .env en la raíz).");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const disponibles = new Set();
for await (const m of await ai.models.list()) {
  // La API devuelve "models/gemini-3.7-flash"; el config usa el nombre corto.
  disponibles.add(String(m.name).replace(/^models\//, ""));
}

console.log(`Modelos configurados (${modelos.length}), en orden de intento:\n`);
let primeroVivo = null;
for (const nombre of modelos) {
  // `-latest` es un alias: no siempre aparece listado aunque funcione.
  const alias = nombre.endsWith("-latest");
  const vivo = disponibles.has(nombre);
  const estado = vivo ? "OK" : alias ? "alias (no listado, puede funcionar)" : "NO EXISTE";
  if (vivo && !primeroVivo) primeroVivo = nombre;
  console.log(`  ${vivo ? "✓" : "✗"} ${nombre.padEnd(22)} ${estado}`);
}

const muertosDelante = modelos.slice(0, modelos.indexOf(primeroVivo ?? modelos[0]))
  .filter((n) => !n.endsWith("-latest"));

console.log("");
if (!primeroVivo) {
  console.log("Ningún modelo configurado aparece en el catálogo. Revisa src/config.ts.");
  process.exit(1);
}
console.log(`En producción se usará: ${primeroVivo}`);
if (muertosDelante.length) {
  console.log(
    `Aviso: ${muertosDelante.length} modelo(s) retirado(s) por delante (${muertosDelante.join(", ")}).`
  );
  console.log("Cada uno cuesta una petición fallida en cada extracción. Quítalos de GEMINI_MODELS.");
} else {
  console.log("Sin modelos retirados por delante: no se desperdicia ninguna petición.");
}
