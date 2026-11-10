import { PartMediaResolutionLevel, Type, type Part } from "@google/genai";
import { EXTRACTION_INSTRUCTION, EXTRACTION_PROMPT as PROMPT, GEMINI_MODELS as MODELS } from "@/config";
import type { RecorteFila } from "./rowCrop";
import type { Renglones, Zona } from "./tableCrop";

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

/** Error de la API con su código HTTP, para saber si el modelo está saturado. */
class ErrorModelo extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Salud de los modelos
// ---------------------------------------------------------------------------
// Un modelo saturado tarda ~20 s en devolver 503, o se cuelga hasta agotar el límite.
// Sin memoria, cada acta (y cada página) volvía a pagar ese tiempo con el mismo modelo
// antes de pasar al siguiente. Se recuerda el fallo y, mientras tanto, ese modelo se
// prueba al final en vez de al principio. No se descarta: si los demás también fallan,
// se le sigue dando su oportunidad.
const PENALIZACION_SATURADO_MS = 5 * 60_000;
// Cuota (429). Google dice en el propio error cuánto falta para que se libere: segundos
// si es el límite por minuto, horas si es el diario del plan gratuito (20 peticiones al
// día por modelo). Se respeta ese plazo; si no viene, se asume el límite por minuto.
const PENALIZACION_CUOTA_MS = 60_000;
// A partir de aquí una penalización ya no es "espera un poco" sino "hoy no": el modelo
// se salta del todo mientras quede algún otro disponible.
const UMBRAL_AGOTADO_MS = 10 * 60_000;

// Se guarda en el navegador para que sobreviva a recargar la página: sin esto, cada
// recarga volvía a gastar ~7 s por modelo agotado y por envío antes de dar con uno vivo.
const CLAVE_SALUD = "intelliextract.modelosPenalizados";

function cargarSalud(): Map<string, number> {
  try {
    const guardado = JSON.parse(localStorage.getItem(CLAVE_SALUD) || "{}") as Record<string, number>;
    return new Map(Object.entries(guardado).filter(([, hasta]) => hasta > Date.now()));
  } catch {
    return new Map(); // modo privado, almacenamiento bloqueado o dato corrupto
  }
}

const saturadoHasta = cargarSalud();

function penalizar(modelo: string, ms: number) {
  saturadoHasta.set(modelo, Date.now() + ms);
  try {
    localStorage.setItem(CLAVE_SALUD, JSON.stringify(Object.fromEntries(saturadoHasta)));
  } catch { /* sin almacenamiento: la memoria de esta pestaña sigue valiendo */ }
}

/** Plazo que da Google en un 429 ("retryDelay":"20269s"), con tope de un día. */
function esperaDeCuota(mensaje: string): number {
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(mensaje);
  const ms = m ? parseFloat(m[1]) * 1000 : 0;
  return Math.min(Math.max(ms, PENALIZACION_CUOTA_MS), 24 * 3600_000);
}

/** Intento cortado a propósito porque otra página ya vio el modelo saturado. */
class ErrorCancelado extends Error {}

// Peticiones en vuelo por modelo. Las páginas van en paralelo: cuando una recibe un 503 o
// un 504, las demás que esperan a ese mismo modelo casi seguro acabarán igual (medido:
// una página se quedó 90 s colgada en un modelo que otra petición ya había visto caído),
// así que se cancelan y pasan al siguiente.
//
// Un 429 NO cancela a nadie: es la cuota por minuto de ESA petición, y las demás ya
// fueron admitidas. Cancelarlas (primera versión de esto) desataba una cascada: un 429
// tumbaba las 6 páginas, saltaban juntas al siguiente modelo, otro 429, y así hasta
// agotar la cadena entera.
const enCurso = new Map<string, Set<AbortController>>();

function registrarFallo(modelo: string, error: unknown) {
  if (error instanceof ErrorCancelado) return; // ya registrado por quien lo vio
  const status = error instanceof ErrorModelo ? error.status : error instanceof TypeError ? 503 : 0;
  if (status === 429) {
    penalizar(modelo, esperaDeCuota((error as Error).message));
  } else if (status >= 500) {
    penalizar(modelo, PENALIZACION_SATURADO_MS);
    for (const control of enCurso.get(modelo) ?? []) {
      control.abort(new ErrorCancelado(`${modelo} está saturado: se pasa al siguiente modelo.`));
    }
  }
}

/**
 * Ejecuta un intento registrándolo como "en vuelo" para poder cancelarlo desde fuera.
 * El último modelo de la cadena no se registra: cancelarlo no lleva a ningún sitio mejor.
 */
async function conCancelacion<T>(
  modelo: string,
  cancelable: boolean,
  fn: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (!cancelable) return fn();
  const control = new AbortController();
  const vivos = enCurso.get(modelo) ?? new Set<AbortController>();
  enCurso.set(modelo, vivos.add(control));
  try {
    return await fn(control.signal);
  } finally {
    vivos.delete(control);
  }
}

/**
 * Orden de intento: primero los modelos sanos, luego los penalizados por poco tiempo
 * (el que antes se recupera, antes). Los que tienen la cuota del día agotada se saltan,
 * salvo que no quede ningún otro: entonces se prueban igual, por si el dato guardado ya
 * no vale (p. ej. se activó la facturación).
 */
function ordenarPorSalud(modelos: string[]): string[] {
  const ahora = Date.now();
  const resta = (m: string) => Math.max(0, (saturadoHasta.get(m) ?? 0) - ahora);
  const sanos = modelos.filter((m) => resta(m) === 0);
  const tocados = modelos.filter((m) => resta(m) > 0).sort((a, b) => resta(a) - resta(b));
  const recuperables = tocados.filter((m) => resta(m) <= UMBRAL_AGOTADO_MS);
  return sanos.length + recuperables.length > 0 ? [...sanos, ...recuperables] : tocados;
}

/** Texto para el usuario cuando todo falló por cuota: cuánto falta para el primero. */
function avisoDeCuota(modelos: string[]): string {
  const falta = Math.min(...modelos.map((m) => (saturadoHasta.get(m) ?? 0) - Date.now()));
  const cuando = falta > 3600_000 ? `en unas ${Math.ceil(falta / 3600_000)} h`
    : falta > 60_000 ? `en unos ${Math.ceil(falta / 60_000)} min` : "en un minuto";
  return (
    `Se agotó la cuota gratuita de Gemini en todos los modelos (20 peticiones al día por modelo). ` +
    `Vuelve a intentarlo ${cuando}, o activa la facturación en Google AI Studio para quitar el límite.`
  );
}

// Límite por intento, proporcional a las páginas del envío. Con el formato compacto un
// envío de 3 páginas sale en ~10-15 s (hasta ~30 s con el servicio cargado); si pasa
// holgadamente de eso, el modelo está saturado y conviene pasar al siguiente. El último
// de la cadena recibe más margen: si llegó hasta ahí, cortarlo antes solo cambiaría una
// espera por un error. (El servidor recorta todo a 280 s para no chocar con los 300 s de
// maxDuration en Vercel.)
const TIEMPO_BASE_MS = 30_000;
const TIEMPO_POR_PAGINA_MS = 10_000;

function tiempoIntento(paginas: number, esUltimo: boolean): number {
  const base = TIEMPO_BASE_MS + TIEMPO_POR_PAGINA_MS * paginas;
  return esUltimo ? base * 2.5 : base;
}

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
  timeoutMs?: number;
}, signal?: AbortSignal): Promise<RespuestaGemini> {
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
    signal,
  });
  // Vercel responde algunos fallos (413, timeout) con texto plano, no con JSON.
  const datos = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 413) {
      throw new ErrorTamano("El envío es demasiado grande para el servidor (límite de 4.5 MB).");
    }
    throw new ErrorModelo(datos?.error || `El servidor respondió ${res.status}.`, res.status);
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
 * Construye las partes de la petición. Cada imagen va precedida de su etiqueta
 * "Archivo N": es el N que el modelo devuelve en @IMAGEN para decir de cuál habla.
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

  parts.push({ text: EXTRACTION_INSTRUCTION });

  return parts;
}

export interface ArchivoEntrada {
  data: string;
  mimeType: string;
  name: string;
  /** Página real dentro del documento (1-based). Solo para PDFs de varias hojas. */
  pagina?: number;
  /** Si la imagen es un recorte de la página, la zona que ocupa en ella (ver tableCrop.ts). */
  recorte?: Zona;
  /** Renglones de la tabla medidos por la app sobre la página (ver tableCrop.ts). */
  renglones?: Renglones;
}

// Páginas por envío: es el punto de equilibrio entre velocidad y cuota.
//  - Velocidad: una página por envío es lo más rápido (7 hojas en paralelo: ~45 s en
//    total, frente a ~140 s de un envío de 4 páginas razonando al máximo).
//  - Cuota: el plan gratuito de Gemini da 20 peticiones AL DÍA por modelo. Con una página
//    por envío, un acta de 7 hojas gasta 7 peticiones y el día se acaba en ~14 actas.
// Con 3, un acta de 7 hojas gasta 3 peticiones (3+3+1). Con facturación activada en
// Google AI Studio el tope diario desaparece y conviene volver a 1.
const PAGINAS_POR_ENVIO = 3;

// Cuántos envíos van a la vez. El tope evita disparar un PDF de 30 hojas de golpe.
const ENVIOS_EN_PARALELO = 4;

// Presupuesto por envío, por debajo del límite duro (4.3 MB) para dejar sitio a las
// etiquetas, el prompt del sistema y el envoltorio JSON.
const PRESUPUESTO_ENVIO_BYTES = 3.8 * 1024 * 1024;

/**
 * Agrupa las páginas en envíos contiguos de PAGINAS_POR_ENVIO. Si un grupo no cabe (fotos
 * muy pesadas), se manda página a página.
 */
function agruparEnEnvios(files: ArchivoEntrada[]): ArchivoEntrada[][] {
  const envios: ArchivoEntrada[][] = [];
  for (let i = 0; i < files.length; i += PAGINAS_POR_ENVIO) {
    const grupo = files.slice(i, i + PAGINAS_POR_ENVIO);
    const peso = grupo.reduce((acc, f) => acc + f.data.length, 0);
    if (peso <= PRESUPUESTO_ENVIO_BYTES) envios.push(grupo);
    else envios.push(...grupo.map((f) => [f]));
  }
  return envios;
}

async function enParalelo<T, R>(items: T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      resultados[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador));
  return resultados;
}

interface FilaLeida {
  nombre: string;
  dni: string;
  origen: string;   // nombre del documento, sin el sufijo de página
  fila: string;     // renglón físico dentro de su página
  pagina: number;   // página real del documento
  anclas: string;   // "yPrimera,xIzq,yUltima,xDer" en 0-1000 de la página ENTERA
  total: string;    // renglones de la tabla de esa página
}

/** Pasa el anclaje de coordenadas del recorte (0-1000) a las de la página entera. */
function anclasEnPagina(anclas: string, recorte?: Zona): string {
  const v = anclas.split(",").map((n) => parseFloat(n));
  if (v.length !== 4 || v.some((n) => isNaN(n))) return "";
  if (!recorte) return v.map((n) => Math.round(n)).join(",");
  const y = (n: number) => Math.round((recorte.y0 + (n / 1000) * (recorte.y1 - recorte.y0)) * 1000);
  const x = (n: number) => Math.round((recorte.x0 + (n / 1000) * (recorte.x1 - recorte.x0)) * 1000);
  return [y(v[0]), x(v[1]), y(v[2]), x(v[3])].join(",");
}

/**
 * Interpreta la respuesta compacta del modelo (formato definido en EXTRACTION_PROMPT):
 *
 *   @IMAGEN;N;yPrimera,xIzq,yUltima,xDer;TotalRenglones
 *   Renglon;Apellidos y Nombres;DNI
 *
 * La página de cada fila NO se le pregunta al modelo: sale de la imagen N del envío, que
 * la app sabe a qué hoja corresponde. Antes el modelo la escribía en cada fila y a veces
 * numeraba desde 1 dentro del envío, con lo que el visor abría la hoja equivocada.
 *
 * Lanza un error (y se prueba el siguiente modelo) si falta el bloque de alguna imagen:
 * aceptar la respuesta sería dar por buena una hoja entera sin leer.
 */
function interpretarRespuesta(texto: string, lote: ArchivoEntrada[]): FilaLeida[] {
  const filas: FilaLeida[] = [];
  const vistas = new Set<number>();
  let actual = 0, anclas = "", total = "";

  for (const linea of texto.split("\n").map((l) => l.trim())) {
    if (!linea || linea.startsWith("```")) continue;
    const cols = linea.split(";").map((c) => c.trim());

    if (/^@IMAGEN$/i.test(cols[0])) {
      const n = parseInt(cols[1], 10);
      // Un N fuera de rango se toma por orden de aparición: mejor que tirar el bloque.
      actual = n >= 1 && n <= lote.length ? n - 1 : Math.min(vistas.size, lote.length - 1);
      vistas.add(actual);
      total = /^\d+$/.test(cols[3] ?? "") ? cols[3] : "";
      // Si la app midió los renglones sobre las líneas impresas y el modelo cuenta los
      // mismos, se usa esa medida: es exacta. Las coordenadas del modelo quedan para
      // cuando no hay medida local o los recuentos no cuadran (no hablarían de los mismos
      // renglones, y numerar con una geometría ajena desplazaría todas las marcas).
      const medida = lote[actual].renglones;
      if (medida && (total === "" || total === String(medida.total))) {
        total = String(medida.total);
        anclas = [medida.yPrimera, medida.xIzq, medida.yUltima, medida.xDer].map((v) => Math.round(v * 1000)).join(",");
      } else {
        anclas = anclasEnPagina(cols[2] ?? "", lote[actual].recorte);
      }
      continue;
    }
    if (!/^\d+$/.test(cols[0]) || cols.length < 3) continue; // cabecera u otro texto suelto

    const archivo = lote[actual];
    filas.push({
      // Si un nombre trajera un ";" suelto, el DNI sigue siendo la última columna.
      nombre: cols.slice(1, -1).join(" "),
      dni: cols[cols.length - 1],
      origen: archivo.name.replace(/\s*\(página \d+\)$/, ""),
      fila: cols[0],
      pagina: archivo.pagina ?? 1,
      anclas,
      total,
    });
  }

  if (vistas.size === 0 && filas.length === 0) {
    throw new Error("La respuesta del modelo no sigue el formato esperado.");
  }
  if (vistas.size < lote.length && lote.length > 1) {
    throw new Error(`El modelo solo informó de ${vistas.size} de las ${lote.length} imágenes del envío.`);
  }
  return filas;
}

/**
 * Extrae un documento: las páginas van en grupos (agruparEnEnvios), los envíos en
 * paralelo, y todo se une en un único CSV. Cada hoja de estas fichas es independiente, así
 * que separarlas no le quita al modelo contexto que necesite; y cada envío queda por
 * debajo del límite de 4.5 MB de Vercel, sea cual sea el número de hojas.
 */
export async function processDocuments(files: ArchivoEntrada[]): Promise<ProcessedResult> {
  const lotes = agruparEnEnvios(files);
  const t0 = performance.now();

  const resultados = await enParalelo(lotes, ENVIOS_EN_PARALELO, (lote) => extraerLote(lote));
  console.log(
    `Extracción de ${files.length} página(s) en ${lotes.length} envío(s) ` +
    `(${lotes.map((l) => l.length).join(" + ")}): ${((performance.now() - t0) / 1000).toFixed(1)} s.`
  );

  // El resto de la app trabaja con el CSV de 10 columnas. Ocupación y Área quedan vacías
  // a propósito: no se le piden al modelo porque la app las toma de la lista maestra.
  const lineas = resultados
    .flatMap((r) => r.filas)
    .map((f, i) => [i + 1, f.nombre, f.dni, "", "", f.origen, f.fila, f.pagina, f.anclas, f.total].join(";"));
  const csv = [CABECERA_CSV, ...lineas].join("\n");
  // Resultado ya interpretado a la consola: junto con la respuesta cruda de cada envío,
  // permite distinguir si el modelo leyó mal o si el fallo está en la interpretación.
  console.log("=== CSV unido de todos los envíos ===\n" + csv);

  return {
    csv,
    modelUsed: [...new Set(resultados.map((r) => r.modelUsed))].join(" + "),
  };
}

async function extraerLote(files: ArchivoEntrada[]): Promise<{ filas: FilaLeida[]; modelUsed: string }> {
  let lastError: any;
  let soloCuota = true;
  const triedModels: string[] = [];
  const modelos = ordenarPorSalud(MODELS);

  for (const [i, modelName] of modelos.entries()) {
    try {
      console.log(`Intentando extracción con el modelo: ${modelName}`);
      triedModels.push(modelName);

      const response = await conCancelacion(modelName, i < modelos.length - 1, (signal) => llamarGemini({
        model: modelName,
        contents: construirPartes(files, soportaResolucionPorParte(modelName)),
        config: {
          systemInstruction: PROMPT,
          // Transcribir es una tarea determinista: a temperatura por defecto (1.0) el
          // mismo documento podía dar dos lecturas distintas en dos ejecuciones.
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Gemini 3 razona al máximo si no se le dice nada. Medido sobre 60 renglones
          // manuscritos: "low" baja de ~32 s a ~19 s por página y acierta igual o más DNIs
          // contra la maestra (31 vs 29). Leer una tabla no necesita deliberar mucho.
          // Gemini 2.5 no acepta este campo, por eso solo va en los 3.
          ...(/^gemini-3/.test(modelName) ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}),
        },
        timeoutMs: tiempoIntento(files.length, i === modelos.length - 1),
      }, signal));

      if (response.finishReason === "MAX_TOKENS") {
        throw new Error(
          "La respuesta se cortó por longitud: el documento tiene más filas de las que caben en una sola pasada."
        );
      }
      if (!response.text) throw new Error("Respuesta vacía del modelo.");

      // Respuesta cruda a la consola: cuando una extracción sale mal, es la única
      // forma de distinguir si el modelo leyó mal el documento o si el fallo está
      // en cómo la app interpreta la respuesta.
      console.log(`=== Respuesta de ${modelName} ===\n` + response.text);
      const filas = interpretarRespuesta(response.text, files);
      console.log(`¡Éxito con el modelo ${modelName}!`);
      return { filas, modelUsed: modelName };
    } catch (error: any) {
      if (error instanceof ErrorTamano) throw error;
      registrarFallo(modelName, error);
      if (!(error instanceof ErrorModelo && error.status === 429)) soloCuota = false;
      console.error(`Error con el modelo ${modelName}:`, error);
      lastError = error;
    }
  }

  if (soloCuota && lastError) throw new Error(avisoDeCuota(triedModels));
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
  // Aquí NO se baja el razonamiento: son justo los renglones que la pasada normal no
  // resolvió, y deliberar dígito a dígito es lo que se busca. Sí se evita el modelo saturado.
  const modelosRelectura = ordenarPorSalud(MODELOS_RELECTURA);
  for (const [i, modelName] of modelosRelectura.entries()) {
    try {
      const response = await conCancelacion(modelName, i < modelosRelectura.length - 1, (signal) => llamarGemini({
        model: modelName,
        contents: parts,
        config: {
          systemInstruction: PROMPT_RELECTURA,
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
          responseSchema: ESQUEMA_RELECTURA,
        },
        // Los recortes son pequeños: se cuentan como una página cada tres.
        timeoutMs: tiempoIntento(Math.ceil(recortes.length / 3), i === modelosRelectura.length - 1),
      }, signal));

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
      registrarFallo(modelName, error);
      console.error(`Relectura fallida con ${modelName}:`, error);
      lastError = error;
    }
  }

  throw new Error(`No se pudo releer. Último error: ${lastError?.message || String(lastError)}`);
}
