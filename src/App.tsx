// URL del Apps Script Web App (reemplaza por tu URL real)
const GOOGLE_SHEETS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyohGM8PRErgAK4Uq_SXw0b4gQwuCqbV2O9CC64UAS1piAurb9oiZQ2kQiv4YwOn3GL/exec";
// Función para resaltar coincidencias en texto
function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return text.split(regex).map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} style={{ background: "#ffe066", padding: 0 }}>{part}</mark>
    ) : part
  );
}
function highlightSearchMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const tokens = query.trim().split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length === 0) return text;
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} style={{ background: "#bfdbfe", padding: 0, borderRadius: 2, fontWeight: 700 }}>{part}</mark>
      : part
  );
}
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { 
  Upload, FileText, X, Play, Copy, Database, 
  CheckCircle2, AlertCircle, FileDigit, Download, Settings, Loader2, 
  UserCheck, UserMinus, Search, SearchCode, Eye, ZoomIn, ZoomOut, Sparkles, 
  ArrowUpDown, ArrowUp, ArrowDown, Filter, ChevronDown, ChevronLeft, ChevronRight, Check, Image as ImageIcon,
  Maximize2, RotateCcw, MousePointer2, Grab, Menu, PanelLeftClose, PanelLeftOpen, Link2, Layers, FilterX
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { processDocuments, releerFilas } from "./lib/gemini";
import { recortarFilas, type RecorteFila } from "./lib/rowCrop";
import { copiarTexto } from "./lib/clipboard";
import { renderPdfToImages } from "./lib/pdf";
import { enhanceForOcr } from "./lib/imagePrep";
import { detectDataRowBands } from "./lib/rowDetect";
import { APP_NAME, APP_SUBTITLE, MASTER_DATA_URL } from "./config";
import { normalizeDniStrict, nameMatchScore, dniFuzzyScore, combinedMatchScore, confidenceLevel, normalizeText } from "./lib/matching";

interface DocumentFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  previewUrl: string | null;
  base64: string;
  pages: string[]; // imágenes (data URL) por página tal cual son; imagen = 1 página
  // Las mismas páginas tras el preprocesado de contraste que se le manda al OCR.
  // Son las que ve el modelo; el visor sigue mostrando `pages` (el documento real).
  // El preprocesado no mueve píxeles, así que las coordenadas de una sirven en la otra.
  ocrPages: { base64: string; mimeType: string }[];
}

interface BBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

// Cómo se resolvió el DNI de la fila. La distinción importa de cara a quien revisa:
// AUTO es aritmética local (matching.ts) y se puede auditar sola; IA implica que hubo
// una lectura de Gemini de por medio. Antes ambos casos se etiquetaban "IA", lo que
// atribuía a un modelo coincidencias que en realidad calcula un algoritmo determinista.
type MatchMethod =
  | "DEFAULT"  // tal como salió de la extracción, sin vincular
  | "MANUAL"   // una persona escribió o confirmó el DNI
  | "AUTO"     // vinculado por el algoritmo de similitud local, sin IA
  | "IA";      // releído por el modelo (relectura de renglón)

// Estado de extracción de cada documento del lateral. Los proyectos son independientes:
// cada uno se extrae por su cuenta y conserva su resultado aunque los demás cambien.
type EstadoProyecto = "pendiente" | "procesando" | "listo" | "error";

// Cómo se está mirando un proyecto: qué filas oculta y en qué orden las muestra. Se
// guarda por proyecto, así que es parte de su estado y no de la aplicación.
type OrdenVista = { key: string; direction: "asc" | "desc" } | null;
type ColumnasFiltradas = { [key: string]: string[] };
interface FiltrosVista {
  texto: string;             // caja "Filtro..."
  columnas: ColumnasFiltradas; // embudos de cada cabecera
  soloErrores: boolean;      // interruptor "Sin Match"
  orden: OrdenVista;
}
const FILTROS_VACIOS: FiltrosVista = { texto: "", columnas: {}, soloErrores: false, orden: null };

interface ExtractedRow {
  id: string;
  // Documento del que salió la fila, sellado en el momento de extraer. Es la única
  // atribución fiable: el SourceFile que devuelve el modelo a veces es un nombre
  // inventado ("page 2.jpeg") y emparejarlo a posteriori era pura heurística.
  fileId: string;
  nro: string;
  nombre: string;
  dni: string;
  ocupacion: string;
  area: string;
  sourceFile: string;
  filaDoc: string;
  pagina: string;
  bbox: BBox | null;
  rowTotal: number; // total de renglones de su página (para detección de grid)
  method: MatchMethod;
  matchConfidence?: number;
  matchCandidates?: { master: MasterRow; score: number }[];
}

interface MasterRow {
  dni: string;
  nombre: string;
  cargo: string;
  area: string;
}

// Los dos métodos que la máquina decidió sola y llevan porcentaje de confianza. Se
// agrupan aquí para que la insignia y el botón de "Aceptar altas" no se desincronicen
// si mañana aparece un tercer método automático.
const esVinculacionAutomatica = (row: ExtractedRow) =>
  row.method === "AUTO" || row.method === "IA";

// Insignia de método. Estaba duplicada palabra por palabra en la tabla y en las tarjetas
// móviles, así que un cambio de criterio obligaba a tocar dos sitios y era fácil que uno
// se quedara atrás.
const methodBadge = (row: ExtractedRow): { label: string; className: string } => {
  if (!esVinculacionAutomatica(row) || row.matchConfidence == null) {
    return {
      label: row.method,
      className:
        row.method === "MANUAL"
          ? "bg-amber-100 text-amber-700 border-amber-200"
          : "bg-slate-100 text-slate-600 border-slate-200",
    };
  }
  const nivel = confidenceLevel(row.matchConfidence);
  return {
    label: `${row.method} ${Math.round(row.matchConfidence * 100)}%`,
    className:
      nivel === "high"
        ? "bg-emerald-100 text-emerald-700 border-emerald-200"
        : nivel === "medium"
          ? "bg-amber-100 text-amber-700 border-amber-200"
          : "bg-purple-100 text-purple-700 border-purple-200",
  };
};

function parseCSVRow(row: string) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Parsea "ymin,xmin,ymax,xmax" (0-1000) a un BBox; devuelve null si es inválido.
function parseBBox(raw: string): BBox | null {
  if (!raw) return null;
  const nums = raw.replace(/[\[\]()]/g, "").split(",").map((n) => parseInt(n.trim(), 10));
  if (nums.length < 4 || nums.some((n) => isNaN(n))) return null;
  let [ymin, xmin, ymax, xmax] = nums;
  // Asegura orden correcto
  if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
  if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
  const clamp = (v: number) => Math.max(0, Math.min(1000, v));
  return { ymin: clamp(ymin), xmin: clamp(xmin), ymax: clamp(ymax), xmax: clamp(xmax) };
}

// Busca y puntúa coincidencias en la lista maestra por DNI o nombre.
function scoreMasterSearch(query: string, masterData: MasterRow[]): { master: MasterRow; score: number; matchType: string }[] {
  const q = query.trim();
  if (!q) return [];

  const qNorm = normalizeText(q);
  const qNormDni = normalizeDniStrict(q);
  const qTokens = qNorm.split(/\s+/).filter((t: string) => t.length >= 2);

  const scored: { master: MasterRow; score: number; matchType: string }[] = [];

  for (const m of masterData) {
    const nameNorm = normalizeText(m.nombre);
    const dniNorm = normalizeDniStrict(m.dni);
    const nameWords = nameNorm.split(/\s+/);

    // --- DNI matches (highest priority) ---
    // Busca desde 2 dígitos: exacto > prefijo > contiene.
    if (qNormDni.length >= 2) {
      if (dniNorm === qNormDni) { scored.push({ master: m, score: 2.0, matchType: 'dni_exact' }); continue; }
      if (dniNorm.startsWith(qNormDni)) { scored.push({ master: m, score: 1.85 - (8 - qNormDni.length) * 0.04, matchType: 'dni_partial' }); continue; }
      if (qNormDni.length >= 3 && dniNorm.includes(qNormDni)) { scored.push({ master: m, score: 1.3, matchType: 'dni_partial' }); continue; }
    }

    // --- Name matches ---
    if (qTokens.length > 0) {
      const allWordStart = qTokens.every((t: string) => nameWords.some((w: string) => w.startsWith(t)));
      if (allWordStart) { scored.push({ master: m, score: 1.1 + (qTokens.length > 1 ? 0.15 : 0), matchType: 'name' }); continue; }
      const allContain = qTokens.every((t: string) => nameNorm.includes(t));
      if (allContain) { scored.push({ master: m, score: 0.85 + (qTokens.length > 1 ? 0.10 : 0), matchType: 'name' }); continue; }
      if (qTokens.some((t: string) => t.length >= 3 && nameWords.some((w: string) => w.startsWith(t)))) { scored.push({ master: m, score: 0.60, matchType: 'name' }); continue; }
      if (qTokens.some((t: string) => t.length >= 3 && nameNorm.includes(t))) { scored.push({ master: m, score: 0.40, matchType: 'name' }); continue; }
    }

    // Fuzzy fallback for longer queries
    if (qNorm.length >= 5) {
      const fuzzy = nameMatchScore(q, m.nombre);
      if (fuzzy >= 0.62) scored.push({ master: m, score: fuzzy * 0.50, matchType: 'fuzzy' });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 15);
}

export default function App() {
  const [sending, setSending] = useState(false);
  // Aviso propio en vez de alert(): los diálogos nativos los suprimen bastantes
  // navegadores (sobre todo en móvil), y cuando eso pasa la acción se completa o falla
  // sin que el usuario vea absolutamente nada y parezca que el botón está roto.
  const [toast, setToast] = useState<{ tipo: "ok" | "error"; msg: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const mostrarToast = useCallback((tipo: "ok" | "error", msg: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ tipo, msg });
    toastTimer.current = window.setTimeout(() => setToast(null), tipo === "error" ? 7000 : 3500);
  }, []);

  // Mismo motivo que el toast: prompt() es un diálogo nativo y puede no aparecer nunca,
  // dejando el envío a Sheets muerto en silencio. Se pide el IdRef dentro de la app.
  const [sheetsModal, setSheetsModal] = useState(false);
  const [idRefInput, setIdRefInput] = useState("");

  // Confirmación del envío a Sheets. Va en un modal que hay que aceptar, no en el aviso
  // que se desvanece solo: el envío es irreversible desde la app y no puede quedar duda
  // de si llegó o no. Un toast de 3 segundos se pierde si miras a otro lado, y entonces
  // la única forma de salir de dudas es ir a la hoja o reenviar y duplicar.
  const [envioOk, setEnvioOk] = useState<{ cantidad: number; idRef: string; proyecto: string } | null>(null);

    // Enviar datos a Google Sheets
    const handleSendToSheets = async (IdRef: string) => {
      if (!IdRef.trim()) {
        mostrarToast("error", "Debe ingresar un IdRef para continuar.");
        return;
      }
      setSheetsModal(false);
      setSending(true);
      try {
        const participantes = displayedData
          .filter((row: ExtractedRow) => !!getMasterInfo(row.dni))
          .map((row: ExtractedRow) => {
            const master = getMasterInfo(row.dni)!;
            const uniqueId = "x" + Math.random().toString(36).substring(2, 8).toUpperCase();
            return {
              Id: uniqueId,
              ParticipanteDNI: master.dni.toUpperCase(),
              Participante: master.nombre.toUpperCase(),
              Cargo: master.cargo.toUpperCase(),
              Area: master.area.toUpperCase()
            };
          });

        if (participantes.length === 0) {
          mostrarToast("error", "No hay participantes con coincidencias válidas para enviar.");
          setSending(false);
          return;
        }
        const response = await fetch(GOOGLE_SHEETS_WEBAPP_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ IdRef, participantes })
        });
        // Apps Script devuelve HTML (no JSON) cuando el despliegue caduca o pide login;
        // response.json() reventaría con un error de parseo que no explica nada.
        const raw = await response.text();
        let result: any;
        try {
          result = JSON.parse(raw);
        } catch {
          throw new Error(
            `El servidor no devolvió JSON (HTTP ${response.status}). Puede que el despliegue de Apps Script haya caducado o exija iniciar sesión.`
          );
        }
        if (result.success) {
          setEnvioOk({
            cantidad: participantes.length,
            idRef: IdRef.trim(),
            proyecto: proyectoActivo ? nombreProyecto(proyectoActivo) : "todos los documentos",
          });
        } else {
          mostrarToast("error", "Error al enviar: " + (result.message || "respuesta sin detalle."));
        }
      } catch (err: unknown) {
        mostrarToast("error", err instanceof Error ? `Error de red o servidor: ${err.message}` : "Error de red o servidor desconocido");
      }
      setSending(false);
    };
  const [files, setFiles] = useState<DocumentFile[]>([]);
  // Cada documento del lateral es un proyecto independiente. Con uno seleccionado, la
  // tabla y TODO lo que sale de la app (copiar, CSV y Sheets) se limitan a sus filas:
  // antes un envío a Sheets arrastraba los participantes de todos los documentos
  // cargados, que es un error silencioso y caro de deshacer del lado de la hoja.
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // Título que el usuario le pone a cada proyecto, solo para orientarse en el lateral
  // cuando los archivos se llaman "B.pdf" y "C.pdf". Vive ÚNICAMENTE en memoria: no se
  // persiste, no entra en el CSV ni viaja a Sheets, y se pierde al recargar. Si algún
  // día hace falta que salga en una exportación, tendrá que ser una decisión explícita,
  // no un efecto colateral de haber escrito algo en esta caja.
  const [projectTitles, setProjectTitles] = useState<Record<string, string>>({});

  // Estado de extracción por documento. Sin esto no había forma de saber qué proyecto ya
  // se había procesado, y el botón relanzaba todos cada vez.
  const [estadoProyectos, setEstadoProyectos] = useState<Record<string, EstadoProyecto>>({});
  const estadoDe = (f: DocumentFile): EstadoProyecto => estadoProyectos[f.id] ?? "pendiente";

  // Cómo nombrar un documento en pantalla: el título si lo hay, si no el nombre real.
  const nombreProyecto = (f: DocumentFile) => projectTitles[f.id]?.trim() || f.name;
  const [status, setStatus] = useState<"idle" | "processing" | "success" | "error">("idle");
  const [extractedData, setExtractedData] = useState<ExtractedRow[]>([]);
  const [masterData, setMasterData] = useState<MasterRow[]>([]);
  const [masterStatus, setMasterStatus] = useState<"cargando" | "ok" | "error">("cargando");
  const [modelUsed, setModelUsed] = useState<string>("");
  const [relecturaBusy, setRelecturaBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isApiKeyMissing, setIsApiKeyMissing] = useState<boolean>(false);
  
  useEffect(() => {
    // Check for API key on mount
    const key = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (!key) {
      setIsApiKeyMissing(true);
      setErrorMessage("ADVERTENCIA: Falta la variable de entorno VITE_GEMINI_API_KEY. Configúrala en Vercel para que la extracción funcione.");
    }
  }, []);
  
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewerQuery, setViewerQuery] = useState("");
  const [copiedDni, setCopiedDni] = useState<string | null>(null);
  
  // Viewer state
  const [viewingImage, setViewingImage] = useState<{ url: string, name: string, bbox: BBox | null, fila: string, pagina: string, totalPages: number, rowId: string | null } | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [bboxNudge, setBboxNudge] = useState(0); // corrección manual ±filas para la marca
  const [viewerDropdownOpen, setViewerDropdownOpen] = useState(false); // navegador de registros FUERA en el visor
  const [viewerError, setViewerError] = useState<string | null>(null); // aviso cuando no se puede abrir el documento

  // Filtros y orden POR PROYECTO. Los proyectos son independientes también en esto: al
  // cambiar de documento no se arrastra el filtro del anterior (que ocultaría filas sin
  // motivo aparente) ni se pierde el que ya se tenía puesto al volver.
  //
  // La vista "todos los documentos" es un contexto más, con su propia clave, para que
  // tampoco se pisen entre sí.
  const CLAVE_TODOS = "__todos__";
  const [filtrosPorProyecto, setFiltrosPorProyecto] = useState<Record<string, FiltrosVista>>({});
  const claveFiltros = activeFileId ?? CLAVE_TODOS;
  const filtros = filtrosPorProyecto[claveFiltros] ?? FILTROS_VACIOS;

  // Escribe solo en el contexto actual. Los demás proyectos quedan intactos.
  const aplicarFiltros = (patch: Partial<FiltrosVista>) =>
    setFiltrosPorProyecto((prev) => ({
      ...prev,
      [claveFiltros]: { ...(prev[claveFiltros] ?? FILTROS_VACIOS), ...patch },
    }));

  // Alias con la forma de useState para no reescribir cada punto de uso de la tabla, y
  // para que añadir un filtro nuevo siga siendo un cambio de una línea.
  const tableFilter = filtros.texto;
  const sortConfig = filtros.orden;
  const activeFilters = filtros.columnas;
  const showOnlyErrors = filtros.soloErrores;
  const setTableFilter = (v: string) => aplicarFiltros({ texto: v });
  const setShowOnlyErrors = (v: boolean) => aplicarFiltros({ soloErrores: v });
  const setSortConfig = (v: OrdenVista | ((prev: OrdenVista) => OrdenVista)) =>
    aplicarFiltros({ orden: typeof v === "function" ? v(filtros.orden) : v });
  const setActiveFilters = (
    v: ColumnasFiltradas | ((prev: ColumnasFiltradas) => ColumnasFiltradas)
  ) => aplicarFiltros({ columnas: typeof v === "function" ? v(filtros.columnas) : v });

  // Qué menú de embudo está abierto. Es estado de la interfaz, no un filtro: no pertenece
  // al proyecto y se cierra al cambiar de contexto.
  const [openFilterMenu, setOpenFilterMenu] = useState<string | null>(null);
  
  // Avance de la carga de documentos (leer → rasterizar páginas → limpiar imagen).
  const [uploadProgress, setUploadProgress] = useState<{
    archivo: string; indice: number; total: number; pct: number; fase: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // Colapso de la barra lateral en escritorio (en móvil el panel ya se abre/cierra con isMobileMenuOpen).
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebarCollapsed") === "1"; } catch { return false; }
  });
  // Se guarda el id del registro, no su posición: la lista se filtra y se ordena en vivo.
  const [activeCandidateRow, setActiveCandidateRow] = useState<string | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    // El DNI son 8 dígitos en fuente monoespaciada: con 130 px la caja los recortaba
    // y solo se veían 6, que parecían DNIs mal leídos sin serlo.
    nro: 60, ver: 60, nombre: 200, dni: 170, estado: 80, method: 110, sourceFile: 130, filaDoc: 90, dniSheets: 130, nombreOficial: 220
  });
  const resizingRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem("sidebarCollapsed", isSidebarCollapsed ? "1" : "0"); } catch { /* modo privado */ }
  }, [isSidebarCollapsed]);

  // Sin lista maestra no hay contra qué cruzar y TODOS los registros salen FUERA. Antes
  // el fallo solo se escribía en la consola, así que parecía que la app no reconocía a
  // nadie cuando en realidad no tenía con quién comparar. Ahora se reintenta y se avisa.
  const cargarMaestra = useCallback(async (intentos = 3) => {
    setMasterStatus("cargando");
    for (let i = 0; i < intentos; i++) {
      try {
        const response = await fetch(MASTER_DATA_URL);
        if (!response.ok) throw new Error(`El servidor respondió ${response.status}`);
        const text = await response.text();
        const rows = text.split("\n").filter((r) => r.trim());
        const parsed: MasterRow[] = rows.slice(1).map((row) => {
          const cols = parseCSVRow(row);
          return {
            dni: cols[0] || "",
            nombre: cols[5] || "",
            cargo: cols[8] || "",
            area: cols[9] || ""
          };
        }).filter((r) => r.dni);
        if (parsed.length === 0) throw new Error("La lista maestra llegó vacía");
        setMasterData(parsed);
        setMasterStatus("ok");
        return;
      } catch (err) {
        console.error(`Fallo al cargar la lista maestra (intento ${i + 1}/${intentos}):`, err);
        if (i < intentos - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    setMasterStatus("error");
  }, []);

  useEffect(() => { cargarMaestra(); }, [cargarMaestra]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const { col, startX, startWidth } = resizingRef.current;
      const diff = e.clientX - startX;
      setColWidths(prev => ({ ...prev, [col]: Math.max(50, startWidth + diff) }));
    };
    const handleMouseUp = () => { resizingRef.current = null; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Al cambiar de proyecto se cierran los menús abiertos: pertenecen a la vista anterior
  // y mostrarían los valores del documento equivocado.
  useEffect(() => {
    setOpenFilterMenu(null);
    setActiveCandidateRow(null);
    setEditingRowId(null);
  }, [activeFileId]);

  // El aviso del visor se descarta solo.
  useEffect(() => {
    if (!viewerError) return;
    const t = setTimeout(() => setViewerError(null), 6000);
    return () => clearTimeout(t);
  }, [viewerError]);

  const handleResizeStart = (col: string, clientX: number, currentWidth: number) => {
    resizingRef.current = { col, startX: clientX, startWidth: currentWidth };
  };

  // Índice DNI → persona, construido una vez por carga de la maestra.
  //
  // Antes esto era un masterData.find() que normalizaba los 708 DNI de la lista en CADA
  // consulta. getMasterInfo se llama por fila de la tabla, por contador de la cabecera y
  // dentro de varios useMemo, así que un solo repintado disparaba cientos de miles de
  // normalizaciones de texto. Ese era el coste que se notaba al navegar y el que hacía
  // que cada paso de zoom (que repinta la app entera) tardara.
  const masterIndex = useMemo(() => {
    const idx = new Map<string, MasterRow>();
    masterData.forEach((m: MasterRow) => {
      const k = normalizeDniStrict(m.dni);
      // El primero gana, igual que hacía find(), para no alterar resultados con duplicados.
      if (k && !idx.has(k)) idx.set(k, m);
    });
    return idx;
  }, [masterData]);

  const getMasterInfo = (dni: string) => {
    const normalized = normalizeDniStrict(dni);
    if (!normalized) return undefined;
    return masterIndex.get(normalized);
  };

  const handleFilesAdded = async (newFiles: FileList | null) => {
    if (!newFiles || newFiles.length === 0) return;
    const validFiles = Array.from(newFiles).filter((f: File) => f.type.startsWith("image/") || f.type === "application/pdf");
    if (validFiles.length === 0) return;
    const newProcessedFiles: DocumentFile[] = [];

    // Reparto del avance dentro de un documento: leerlo es rápido, rasterizar las
    // páginas es lo más lento y limpiarlas va después.
    const FIN_LECTURA = 8, FIN_RASTER = 55;
    // Cede el hilo para que el navegador pinte la barra antes del siguiente paso pesado.
    const repintar = () => new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < validFiles.length; i++) {
      const f = validFiles[i];
      const avance = async (pct: number, fase: string) => {
        setUploadProgress({ archivo: f.name, indice: i + 1, total: validFiles.length, pct: Math.round(pct), fase });
        await repintar();
      };
      try {
        await avance(0, "Leyendo archivo");
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        let pages: string[] = [];
        let previewUrl: string | null = null;
        await avance(FIN_LECTURA, "Preparando documento");

        if (f.type.startsWith("image/")) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(f);
          });
          pages = [dataUrl];
          previewUrl = dataUrl;
          await avance(FIN_RASTER, "Imagen lista");
        } else if (f.type === "application/pdf") {
          try {
            pages = await renderPdfToImages(base64Data, 2600, (hechas, total) => {
              const pct = FIN_LECTURA + ((FIN_RASTER - FIN_LECTURA) * hechas) / Math.max(1, total);
              setUploadProgress({
                archivo: f.name, indice: i + 1, total: validFiles.length,
                pct: Math.round(pct), fase: `Procesando página ${Math.min(hechas + 1, total)} de ${total}`,
              });
            });
            previewUrl = pages[0] || null;
          } catch (err) {
            console.error("No se pudo renderizar el PDF:", f.name, err);
          }
        }

        // Limpieza de sombras y contraste antes de mandarlo al OCR (visión clásica).
        // En serie y no en paralelo: así el avance es real y no se dispara la memoria
        // con un PDF de muchas hojas.
        const ocrPages: { base64: string; mimeType: string }[] = [];
        for (let p = 0; p < pages.length; p++) {
          const pct = FIN_RASTER + ((100 - FIN_RASTER) * p) / Math.max(1, pages.length);
          await avance(pct, pages.length > 1 ? `Mejorando imagen ${p + 1} de ${pages.length}` : "Mejorando imagen");
          const prep = await enhanceForOcr(pages[p]);
          ocrPages.push({ base64: prep.base64, mimeType: prep.mimeType });
        }
        await avance(100, "Listo");

        newProcessedFiles.push({
          id: Math.random().toString(36).substring(7),
          name: f.name, size: f.size, mimeType: f.type, base64: base64Data, previewUrl, pages, ocrPages
        });
      } catch (err) { console.error("Error processing file:", f.name, err); }
    }
    setUploadProgress(null);
    if (newProcessedFiles.length > 0) {
      setFiles((prev: DocumentFile[]) => [...prev, ...newProcessedFiles]);
      setStatus("idle");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Extrae UN proyecto. Antes mandaba todos los documentos cargados en una sola llamada
  // y reemplazaba la tabla entera, así que añadir un documento nuevo obligaba a reprocesar
  // (y volver a pagar) los que ya estaban resueltos, perdiendo además las correcciones
  // manuales hechas sobre ellos.
  const executeExtraction = async (target?: DocumentFile) => {
    const objetivo = target ?? proyectoObjetivo;
    if (!objetivo) return;
    setStatus("processing");
    setErrorMessage("");
    setEstadoProyectos((prev) => ({ ...prev, [objetivo.id]: "procesando" }));
    try {
      // Se envían las páginas ya limpiadas. Etiquetar cada una con su número de página
      // además reduce que el modelo se invente el origen de cada fila.
      const inputFormats = (() => {
        const f = objetivo;
        if (!f.ocrPages || f.ocrPages.length === 0) {
          return [{ data: f.base64, mimeType: f.mimeType, name: f.name }]; // por si el preprocesado falló
        }
        if (f.ocrPages.length === 1) {
          return [{ data: f.ocrPages[0].base64, mimeType: f.ocrPages[0].mimeType, name: f.name }];
        }
        return f.ocrPages.map((p, i) => ({
          data: p.base64, mimeType: p.mimeType, name: `${f.name} (página ${i + 1})`,
        }));
      })();
      const result = await processDocuments(inputFormats);
      const rows = result.csv.split('\n').slice(1);

      // Paso 1: parseo crudo (guardando la geometría de tabla y total de filas reportados).
      type RawRow = ExtractedRow & { _tableBox: BBox | null; _totalFilas: number };
      const rawRows: RawRow[] = rows.map((row: string, rowIndex: number) => {
        const cols = row.split(';');
        return {
          id: `r${rowIndex}_${Date.now()}`,
          fileId: objetivo.id,
          nro: cols[0] || "", nombre: cols[1] || "", dni: cols[2] || "",
          ocupacion: cols[3] || "", area: cols[4] || "", sourceFile: cols[5]?.trim() || "",
          filaDoc: cols[6]?.trim() || "",
          pagina: cols[7]?.trim() || "1",
          bbox: null,
          rowTotal: 0,
          method: "DEFAULT" as MatchMethod,
          _tableBox: parseBBox(cols[8]?.trim() || ""),
          _totalFilas: parseInt(cols[9]?.trim() || "", 10),
        };
      }).filter((r: RawRow) => r.nombre || r.dni);

      // Paso 2: consenso de geometría por (archivo + página) para anular el ruido de la IA.
      const median = (arr: number[]) => {
        if (arr.length === 0) return NaN;
        const s = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
      };
      const groups: Record<string, RawRow[]> = {};
      rawRows.forEach((r) => {
        const key = `${r.sourceFile.toLowerCase()}||${r.pagina}`;
        (groups[key] ||= []).push(r);
      });
      const consensus: Record<string, { box: BBox | null; total: number }> = {};
      Object.keys(groups).forEach((key) => {
        const arr = groups[key];
        const boxes = arr.map((a) => a._tableBox).filter((b): b is BBox => !!b);
        const totals = arr.map((a) => a._totalFilas).filter((n) => !isNaN(n) && n > 0);
        // El total no puede ser menor que la fila física más alta detectada.
        const maxFila = Math.max(0, ...arr.map((a) => parseInt(a.filaDoc, 10)).filter((n) => !isNaN(n)));
        const box: BBox | null = boxes.length
          ? {
              ymin: Math.round(median(boxes.map((b) => b.ymin))),
              xmin: Math.round(median(boxes.map((b) => b.xmin))),
              ymax: Math.round(median(boxes.map((b) => b.ymax))),
              xmax: Math.round(median(boxes.map((b) => b.xmax))),
            }
          : null;
        const total = Math.max(Math.round(median(totals)) || 0, maxFila);
        consensus[key] = { box, total };
      });

      // Paso 3: interpolación por CENTROS. box.ymin = centro del primer renglón,
      // box.ymax = centro del último renglón (renglón nº total). Cada fila se ubica
      // proporcionalmente entre ambos centros según su número FilaDoc.
      const clampN = (v: number) => Math.max(0, Math.min(1000, v));
      const parsed: ExtractedRow[] = rawRows.map((r) => {
        const key = `${r.sourceFile.toLowerCase()}||${r.pagina}`;
        const c = consensus[key];
        const fila = parseInt(r.filaDoc, 10);
        let bbox: BBox | null = null;
        if (c && c.box && c.total >= 1 && !isNaN(fila) && fila >= 1) {
          const y1 = c.box.ymin; // centro del primer renglón
          const yN = c.box.ymax; // centro del último renglón
          const N = c.total;
          const rowH = N > 1 ? (yN - y1) / (N - 1) : Math.max(yN - y1, 25);
          const center = y1 + (fila - 1) * rowH;
          bbox = {
            xmin: c.box.xmin,
            xmax: c.box.xmax,
            ymin: clampN(Math.round(center - rowH / 2)),
            ymax: clampN(Math.round(center + rowH / 2)),
          };
        }
        const { _tableBox, _totalFilas, ...clean } = r;
        return { ...clean, bbox, rowTotal: c?.total || 0 };
      });
      // La vinculación local se aplica sola: no tiene coste (es algoritmo, no IA) y
      // dejarla detrás de un botón hacía que el panel se abriera con todo en FUERA
      // aunque los registros fueran perfectamente identificables.
      const { updated } = masterData.length > 0 ? vincularRegistros(parsed) : { updated: parsed };
      // Fusiona en lugar de reemplazar: los demás proyectos conservan sus filas y las
      // correcciones manuales que ya se hicieran sobre ellas. Si este proyecto se vuelve
      // a extraer, se sustituyen solo sus propias filas.
      setExtractedData((prev: ExtractedRow[]) => [
        ...prev.filter((r: ExtractedRow) => r.fileId !== objetivo.id),
        ...updated,
      ]);
      setEstadoProyectos((prev) => ({ ...prev, [objetivo.id]: "listo" }));
      // Se aísla lo recién extraído: es lo que se acaba de pedir, y deja la tabla y las
      // exportaciones apuntando a ese proyecto sin tener que seleccionarlo a mano.
      setActiveFileId(objetivo.id);
      setModelUsed(result.modelUsed);
      setStatus("success");
    } catch (err: any) {
      console.error("Extraction failed:", err);
      setEstadoProyectos((prev) => ({ ...prev, [objetivo.id]: "error" }));
      setStatus("error");
      setErrorMessage(err.message || "Error en el procesamiento.");
    }
  };

  // Vinculación local (sin IA) en una sola pasada: por cada registro se puntúan a la vez
  // el DNI y el nombre contra toda la maestra y se fusionan ambas señales. Dos indicios
  // medios que apuntan a la misma persona valen más que uno solo, así que casos que antes
  // se quedaban FUERA (DNI con 2 dígitos mal + nombre a medio leer) ahora se resuelven.
  const UMBRAL_AUTO = 0.78;      // aplica el match sin preguntar
  const UMBRAL_SUGERENCIA = 0.60; // por debajo no se ofrece nada
  const MARGEN_MINIMO = 0.05;    // ventaja exigida al 1º sobre el 2º para aplicar solo

  // Núcleo de la vinculación, sin tocar estado ni avisar: así puede usarse tanto desde
  // el botón como automáticamente al terminar una extracción.
  const vincularRegistros = (rows: ExtractedRow[]) => {
    let matchesFound = 0;
    let suggestionsFound = 0;
    let ambiguas = 0;

    const updated = rows.map((row: ExtractedRow) => {
      if (getMasterInfo(row.dni)) return row;              // ya está resuelto
      const usaDni = !!row.dni && row.dni.length >= 6;
      const usaNombre = !!row.nombre && row.nombre.length >= 4;
      if (!usaDni && !usaNombre) return row;

      const candidates = masterData
        .map((m: MasterRow) => ({
          master: m,
          score: combinedMatchScore(
            usaDni ? dniFuzzyScore(row.dni, m.dni) : 0,
            usaNombre ? nameMatchScore(row.nombre, m.nombre) : 0
          ),
        }))
        .filter((c) => c.score >= UMBRAL_SUGERENCIA)
        .sort((a, b) => b.score - a.score);

      if (candidates.length === 0) return row;
      const top3 = candidates.slice(0, 3);
      const best = top3[0];
      // Si el segundo candidato está pegado al primero, la elección no está clara:
      // se deja como sugerencia para que decida una persona en vez de arriesgar.
      const margenSuficiente = top3.length < 2 || best.score - top3[1].score >= MARGEN_MINIMO;

      if (best.score >= UMBRAL_AUTO && margenSuficiente) {
        matchesFound++;
        return { ...row, dni: best.master.dni, method: "AUTO" as MatchMethod, matchConfidence: best.score, matchCandidates: top3 };
      }
      if (best.score >= UMBRAL_AUTO) ambiguas++;
      suggestionsFound++;
      return { ...row, matchCandidates: top3 };
    });

    return { updated, matchesFound, suggestionsFound, ambiguas };
  };

  const tryFuzzyMatch = () => {
    // Solo el proyecto a la vista: el botón vive en su barra y las cifras que reporta
    // deben cuadrar con los contadores de la cabecera, que también son del proyecto.
    const { updated, matchesFound, suggestionsFound, ambiguas } = vincularRegistros(datosDelProyecto);
    const porId = new Map(updated.map((r: ExtractedRow) => [r.id, r]));
    setExtractedData((prev: ExtractedRow[]) => prev.map((r: ExtractedRow) => porId.get(r.id) ?? r));
    if (matchesFound > 0 || suggestionsFound > 0) {
      const parts = [];
      if (matchesFound > 0) parts.push(`${matchesFound} coincidencias aplicadas`);
      if (suggestionsFound > 0) parts.push(`${suggestionsFound} sugerencias para revisar`);
      if (ambiguas > 0) parts.push(`${ambiguas} con dos candidatos casi iguales`);
      alert(parts.join(" · ") + ".");
    } else {
      alert("No se encontraron nuevas coincidencias.");
    }
  };

  // Solo el proyecto a la vista: el botón está en su barra y aparece según los contadores
  // de ese proyecto, así que no puede dar por buenas coincidencias de otro que no se
  // está revisando.
  const acceptAllHighConfidence = () => {
    const delProyecto = new Set(datosDelProyecto.map((r: ExtractedRow) => r.id));
    setExtractedData((prev: ExtractedRow[]) => prev.map((row: ExtractedRow) => {
      if (!delProyecto.has(row.id)) return row;
      if (esVinculacionAutomatica(row) && row.matchConfidence != null && row.matchConfidence >= 0.92 && !getMasterInfo(row.dni)) {
        return { ...row, method: "MANUAL" as MatchMethod };
      }
      return row;
    }));
  };

  // --- Relectura puntual: el ÚLTIMO recurso, y el único gasto extra de IA -------------
  //
  // Solo entran aquí las filas que el matching local no logró resolver. La idea es la
  // misma que tiene una persona cuando no distingue un 4 de un 9: acercar la lupa. Se
  // recorta ese renglón y se manda solo, así recibe para él todo el presupuesto de
  // tokens que antes se repartía entre las 20 filas de la hoja.
  //
  // Tope duro: si la maestra no cargó, TODAS las filas salen sin coincidencia y sin este
  // límite se dispararía una relectura del documento entero, que es justo lo contrario
  // de lo que se busca.
  const MAX_RELECTURA = 12;

  // (filasSinCoincidencia se declara junto a datosDelProyecto: depende del proyecto activo.)

  // Por debajo de este tamaño se manda la maestra COMPLETA. Prefiltrar tiene un riesgo
  // que no compensa: si el OCR leyó muy mal, la persona correcta se queda fuera del
  // conjunto candidato y la relectura ya no puede acertar. Con ~700 personas la lista
  // entera son unos 10k tokens de entrada en una única llamada, así que no hay motivo
  // para arriesgarse. El prefiltro queda para maestras grandes, donde sí haría falta.
  const MAX_MAESTRA_COMPLETA = 1200;

  // Convierte "leer 8 dígitos cualesquiera" en "elegir dentro de una lista conocida",
  // que es un problema mucho más fácil: un 4 que parece un 9 se resuelve solo si
  // únicamente una de las dos opciones existe en la lista.
  const construirCandidatos = (filas: ExtractedRow[]) => {
    if (masterData.length <= MAX_MAESTRA_COMPLETA) {
      return masterData.map((m: MasterRow) => ({ dni: m.dni, nombre: m.nombre }));
    }
    const vistos = new Set<string>();
    const out: { dni: string; nombre: string }[] = [];
    filas.forEach((row: ExtractedRow) => {
      const usaDni = !!row.dni && row.dni.length >= 4;
      const usaNombre = !!row.nombre && row.nombre.length >= 3;
      if (!usaDni && !usaNombre) return;
      masterData
        .map((m: MasterRow) => ({
          m,
          s: combinedMatchScore(
            usaDni ? dniFuzzyScore(row.dni, m.dni) : 0,
            usaNombre ? nameMatchScore(row.nombre, m.nombre) : 0
          ),
        }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 25)
        .forEach(({ m }) => {
          if (vistos.has(m.dni)) return;
          vistos.add(m.dni);
          out.push({ dni: m.dni, nombre: m.nombre });
        });
    });
    return out.slice(0, 300);
  };

  const handleRelectura = async () => {
    const objetivo = filasSinCoincidencia.slice(0, MAX_RELECTURA);
    if (objetivo.length === 0) return;
    setRelecturaBusy(true);
    try {
      // Agrupadas por página: cada recorte necesita la imagen de la que sale.
      const porPagina = new Map<string, ExtractedRow[]>();
      objetivo.forEach((r: ExtractedRow) => {
        // Por documento real (fileId), no por el nombre que dijo el modelo: dos
        // documentos distintos pueden traer el mismo SourceFile inventado.
        const key = `${r.fileId}||${r.pagina}`;
        porPagina.set(key, [...(porPagina.get(key) || []), r]);
      });

      const recortes: RecorteFila[] = [];
      for (const filas of porPagina.values()) {
        const file = documentoDeFila(filas[0]);
        if (!file) continue;
        const pages = pagesOf(file);
        const url = pages[resolvePageIdx(file, filas[0].sourceFile, filas[0].pagina)];
        if (!url) continue;
        recortes.push(
          ...(await recortarFilas(url, filas.map((f) => ({ id: f.id, bbox: f.bbox! }))))
        );
      }

      if (recortes.length === 0) {
        alert("No se pudo recortar ningún renglón: falta la ubicación exacta de esas filas.");
        return;
      }

      const { lecturas } = await releerFilas(recortes, construirCandidatos(objetivo));
      const porId = new Map(lecturas.map((l) => [l.id, l]));

      // Solo las filas de este proyecto: la re-vinculación posterior no debe reevaluar
      // registros de otro documento, que podría rehacer un DNI corregido a mano allí.
      const conLecturas = datosDelProyecto.map((row: ExtractedRow) => {
        const l = porId.get(row.id);
        if (!l) return row;
        const nuevoDni = (l.dni || "").replace(/\D/g, "");
        const nombre = l.nombre?.trim() || row.nombre;
        // Si la relectura cae sobre alguien de la maestra, es una resolución limpia.
        // Único punto del programa donde "IA" es literal: el DNI lo leyó el modelo.
        if (nuevoDni && getMasterInfo(nuevoDni)) {
          return { ...row, dni: nuevoDni, nombre, method: "IA" as MatchMethod, matchConfidence: l.confianza };
        }
        // Si no, se conserva lo leído para que el matching local lo reintente: un DNI
        // mejor leído puede cruzar el umbral aunque por sí solo no esté en la lista.
        return { ...row, nombre, dni: nuevoDni || row.dni };
      });

      const { updated } = masterData.length > 0
        ? vincularRegistros(conLecturas)
        : { updated: conLecturas };
      const actualizadas = new Map(updated.map((r: ExtractedRow) => [r.id, r]));
      setExtractedData((prev: ExtractedRow[]) => prev.map((r: ExtractedRow) => actualizadas.get(r.id) ?? r));

      const resueltas = updated.filter(
        (r: ExtractedRow) => porId.has(r.id) && !!getMasterInfo(r.dni)
      ).length;
      alert(
        `Relectura de ${recortes.length} renglón(es): ${resueltas} resuelto(s), ` +
        `${recortes.length - resueltas} sigue(n) sin coincidencia.`
      );
    } catch (err: any) {
      console.error("Relectura fallida:", err);
      alert(`No se pudo releer: ${err.message || err}`);
    } finally {
      setRelecturaBusy(false);
    }
  };

  const getCsvString = () => {
    const header = "DNI;NOMBRE OFICIAL;OCUPACION;AREA;METODO;ORIGEN;FILA DOC";
    const bodyRows = displayedData.map((row: ExtractedRow) => {
      const master = getMasterInfo(row.dni);
      if (!master) return null;
      return `${row.dni.toUpperCase()};${master.nombre.toUpperCase()};${master.cargo.toUpperCase()};${master.area.toUpperCase()};${row.method};${row.sourceFile};${row.filaDoc}`;
    }).filter((r: string | null) => r !== null);
    return [header, ...bodyRows].join('\n');
  };

  // Quita solo la última extensión: "CamScanner 02-08 16.45.jpeg" → "camscanner 02-08 16.45".
  const fileStem = (name: string) => name.toLowerCase().trim().replace(/\.[^.]+$/, "");

  // La IA no siempre repite el nombre real del archivo en SourceFile: a veces inventa
  // nombres sintéticos por página ("page 2.jpeg"). Cuando ese nombre no corresponde a
  // ningún documento cargado, el número que trae suele ser la página real.
  const pageHintFromName = (filename: string): number | null => {
    const m = /(?:p[áa]g(?:ina)?|page|pag|hoja|img|image|scan)[\s._-]*(\d{1,3})/i.exec(filename || "");
    const n = m ? parseInt(m[1], 10) : NaN;
    return !isNaN(n) && n >= 1 ? n : null;
  };

  // Documento del que salió una fila. El fileId sellado durante la extracción es
  // autoritativo; findSourceFile queda solo como red de seguridad para filas que por
  // cualquier motivo no lo lleven.
  const documentoDeFila = (row: ExtractedRow): DocumentFile | undefined =>
    files.find((f: DocumentFile) => f.id === row.fileId) ?? findSourceFile(row.sourceFile);

  // Resuelve el documento de origen a partir del nombre, tolerando que SourceFile no
  // coincida exactamente con el del archivo cargado.
  const findSourceFile = (filename: string): DocumentFile | undefined => {
    if (files.length === 0) return undefined;
    // Con un único documento cargado no hay ambigüedad posible: la fila sale de ese.
    if (files.length === 1) return files[0];
    if (!filename) return undefined;
    const target = filename.toLowerCase().trim();
    const targetStem = fileStem(filename);
    return (
      files.find((f: DocumentFile) => f.name.toLowerCase().trim() === target) ||
      files.find((f: DocumentFile) => fileStem(f.name) === targetStem) ||
      files.find((f: DocumentFile) => !!targetStem && (fileStem(f.name).includes(targetStem) || targetStem.includes(fileStem(f.name))))
    );
  };

  // Páginas navegables del documento (un PDF que no se pudo rasterizar cae a su preview).
  const pagesOf = (file: DocumentFile): string[] =>
    file.pages && file.pages.length > 0 ? file.pages : file.previewUrl ? [file.previewUrl] : [];

  // Índice (base 0) de la página donde vive la fila. Compartido por el visor y por la
  // detección de renglones para que ambos apunten siempre a la misma imagen.
  const resolvePageIdx = (file: DocumentFile, filename: string, pagina: string): number => {
    const total = Math.max(1, pagesOf(file).length);
    const hint = fileStem(file.name) === fileStem(filename || "") ? null : pageHintFromName(filename);
    const paginaNum = parseInt(pagina || "1", 10) || 1;
    const pageNum = hint && paginaNum <= 1 ? hint : paginaNum;
    return Math.min(Math.max(0, pageNum - 1), total - 1);
  };

  // `docConocido` llega cuando la fila trae su fileId: evita volver a adivinar el
  // documento por el nombre que devolvió el modelo.
  const openViewer = (filename: string, pagina: string, bbox: BBox | null, fila: string, rowId: string | null, docConocido?: DocumentFile) => {
    const file = docConocido ?? findSourceFile(filename);
    // Nunca fallar en silencio: el botón "ojo" siempre debe responder algo.
    if (!file) {
      setViewerError(
        files.length === 0
          ? "No hay documentos cargados. Vuelve a subir el archivo para poder verlo."
          : `No se pudo ubicar el documento de origen «${filename || "sin nombre"}» entre los archivos cargados.`
      );
      return;
    }
    const pages = pagesOf(file);
    if (pages.length === 0) {
      setViewerError(`«${file.name}» no se pudo convertir a imagen, así que no hay vista previa disponible.`);
      return;
    }
    const safeIdx = resolvePageIdx(file, filename, pagina);
    setViewingImage({ url: pages[safeIdx], name: file.name, bbox, fila, pagina: String(safeIdx + 1), totalPages: pages.length, rowId });
    fijarVista({ zoom: 1, pan: { x: 0, y: 0 } }, true); setBboxNudge(0);
    setViewerError(null);
  };

  // Abre el documento marcando la fila exacta del registro, con panel de edición.
  // Primero muestra la marca aproximada (IA) y luego la refina detectando el grid real.
  const handleViewRow = async (row: ExtractedRow) => {
    setViewerQuery(row.nombre || row.dni || "");
    const file = documentoDeFila(row);
    openViewer(row.sourceFile, row.pagina, row.bbox, row.filaDoc, row.id, file);

    const fila = parseInt(row.filaDoc, 10);
    if (isNaN(fila) || fila < 1) return;
    if (!file) return;
    const pages = pagesOf(file);
    if (pages.length === 0) return;
    const pageIdx = resolvePageIdx(file, row.sourceFile, row.pagina);

    const xMin = row.bbox ? row.bbox.xmin / 1000 : 0.03;
    const xMax = row.bbox ? row.bbox.xmax / 1000 : 0.97;
    const bands = await detectDataRowBands(pages[pageIdx], xMin, xMax, row.rowTotal);
    if (!bands || !bands.length) return;

    // La marca interpolada a partir de los anclajes de la IA ya da la posición
    // aproximada de la fila; el grid detectado solo debe afinar sus bordes. Por eso se
    // elige la banda cuyo centro cae más cerca de esa posición, en vez de contar bandas
    // por índice: contar obligaba a acertar cuántas líneas hay antes y después de la
    // tabla, y una sola de más (la cabecera del formulario, un pie, un renglón bajo la
    // última fila) corría la cuenta entera y la marca aterrizaba en otra fila.
    const alturaMedia = bands.reduce((s, b) => s + (b.bottom - b.top), 0) / bands.length;
    let band: { top: number; bottom: number } | undefined;

    if (row.bbox) {
      const centroEsperado = (row.bbox.ymin + row.bbox.ymax) / 2000; // fracción 0-1
      let mejorDist = Infinity;
      for (const b of bands) {
        const d = Math.abs((b.top + b.bottom) / 2 - centroEsperado);
        if (d < mejorDist) { mejorDist = d; band = b; }
      }
      // Si ni la banda más cercana queda a menos de una fila de distancia, el grid
      // detectado no se corresponde con esta tabla: es preferible dejar la marca
      // interpolada antes que moverla a un renglón equivocado.
      if (mejorDist > alturaMedia * 1.2) return;
    } else {
      // Sin anclajes de la IA no hay referencia: se cuenta desde el inicio del grid.
      band = bands[Math.min(Math.max(0, fila - 1), bands.length - 1)];
    }
    if (!band) return;

    setViewingImage((prev) =>
      prev && prev.rowId === row.id
        ? {
            ...prev,
            bbox: {
              xmin: row.bbox?.xmin ?? Math.round(xMin * 1000),
              xmax: row.bbox?.xmax ?? Math.round(xMax * 1000),
              ymin: Math.round(band.top * 1000),
              ymax: Math.round(band.bottom * 1000),
            },
          }
        : prev
    );
  };

  // Apertura simple (doble clic en el archivo de la barra lateral): primera página, sin marca.
  const handleViewSource = (filename: string) => {
    setViewerQuery("");
    openViewer(filename, "1", null, "", null);
  };

  // --- Vista del visor (zoom + desplazamiento) --------------------------------------
  //
  // Los eventos de rueda y de arrastre llegan muy por encima de la frecuencia a la que
  // el navegador pinta, y cada setState repinta la app entera (tabla incluida). Antes
  // eso significaba varios renders completos por fotograma. Ahora los refs son la fuente
  // de verdad inmediata —para poder encadenar deltas sin esperar al repintado— y el
  // estado de React se sincroniza una sola vez por fotograma.
  const zoomTargetRef = useRef(1);
  const panTargetRef = useRef({ x: 0, y: 0 });
  const rafVistaRef = useRef<number | null>(null);

  // Un gesto se considera en curso mientras llegan eventos y hasta poco después del
  // último. Solo decide si la capa se mantiene en GPU: durante el gesto interesa la
  // fluidez, y al acabar interesa que el navegador vuelva a rasterizar nítido.
  const [gestoActivo, setGestoActivo] = useState(false);
  const finGestoRef = useRef<number | null>(null);
  const marcarGesto = useCallback(() => {
    setGestoActivo(true);
    if (finGestoRef.current !== null) clearTimeout(finGestoRef.current);
    finGestoRef.current = window.setTimeout(() => setGestoActivo(false), 180);
  }, []);

  const fijarVista = useCallback(
    (v: { zoom?: number; pan?: { x: number; y: number } }, inmediato = false) => {
      if (v.zoom !== undefined) zoomTargetRef.current = Math.min(Math.max(v.zoom, 0.5), 15);
      if (v.pan) panTargetRef.current = v.pan;
      if (inmediato) {
        if (rafVistaRef.current !== null) {
          cancelAnimationFrame(rafVistaRef.current);
          rafVistaRef.current = null;
        }
        setZoomLevel(zoomTargetRef.current);
        setPanOffset(panTargetRef.current);
        return;
      }
      // Solo la vía agrupada cuenta como gesto: las acciones puntuales (botones, reset)
      // deben quedar nítidas de inmediato, sin pasar por la capa de GPU.
      marcarGesto();
      if (rafVistaRef.current !== null) return;
      rafVistaRef.current = requestAnimationFrame(() => {
        rafVistaRef.current = null;
        setZoomLevel(zoomTargetRef.current);
        setPanOffset(panTargetRef.current);
      });
    },
    [marcarGesto]
  );

  useEffect(() => () => {
    if (rafVistaRef.current !== null) cancelAnimationFrame(rafVistaRef.current);
    if (finGestoRef.current !== null) clearTimeout(finGestoRef.current);
  }, []);

  // Advanced Viewer Handlers
  const handlePanStart = (e: React.MouseEvent) => {
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - panTargetRef.current.x, y: e.clientY - panTargetRef.current.y };
  };
  const handlePanMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    fijarVista({ pan: { x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y } });
  }, [isPanning, fijarVista]);
  const handlePanEnd = () => setIsPanning(false);

  // Touch Gestures State
  const touchStartDistRef = useRef<number | null>(null);
  const touchStartZoomRef = useRef<number>(1);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsPanning(true);
      panStartRef.current = { x: e.touches[0].clientX - panTargetRef.current.x, y: e.touches[0].clientY - panTargetRef.current.y };
      touchStartDistRef.current = null;
    } else if (e.touches.length === 2) {
      setIsPanning(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartDistRef.current = Math.hypot(dx, dy);
      touchStartZoomRef.current = zoomTargetRef.current;
    }
  };

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1 && isPanning) {
      fijarVista({ pan: { x: e.touches[0].clientX - panStartRef.current.x, y: e.touches[0].clientY - panStartRef.current.y } });
    } else if (e.touches.length === 2 && touchStartDistRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.hypot(dx, dy);
      const scale = currentDist / touchStartDistRef.current;
      fijarVista({ zoom: touchStartZoomRef.current * scale });
    }
  }, [isPanning, fijarVista]);

  const handleTouchEnd = () => {
    setIsPanning(false);
    touchStartDistRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    // Se parte del ref, no del estado: en una ráfaga de rueda el estado todavía va por
    // el fotograma anterior y los pasos se perderían unos a otros.
    const factor = 1.1;
    const actual = zoomTargetRef.current;
    fijarVista({ zoom: -e.deltaY > 0 ? actual * factor : actual / factor });
  };

  const resetViewer = () => {
    fijarVista({ zoom: 1, pan: { x: 0, y: 0 } }, true);
  };

  // Filas del proyecto activo. Es la base común de los contadores de la cabecera, de la
  // tabla y de las exportaciones, para que las tres cuenten siempre lo mismo.
  //
  // El filtro es una comparación directa de fileId, sellado al extraer. Antes se deducía
  // emparejando de forma difusa el SourceFile devuelto por el modelo con los nombres de
  // los archivos cargados, y ese emparejamiento podía fallar en silencio.
  const datosDelProyecto = useMemo(
    () => (activeFileId ? extractedData.filter((r: ExtractedRow) => r.fileId === activeFileId) : extractedData),
    [extractedData, activeFileId]
  );

  const proyectoActivo = files.find((f: DocumentFile) => f.id === activeFileId);

  // Sobre qué documento actúa "Iniciar Extracción". Con un solo documento cargado no hay
  // ambigüedad y no se obliga a seleccionarlo antes; con varios hay que elegir, porque
  // adivinar cuál se quiere procesar es justo lo que hacía mal antes.
  const proyectoObjetivo = proyectoActivo ?? (files.length === 1 ? files[0] : undefined);
  const estadoObjetivo = proyectoObjetivo ? estadoDe(proyectoObjetivo) : null;

  // Contadores de la cabecera en una sola pasada. Estaban escritos como seis .filter()
  // independientes sobre la misma lista, todos ellos consultando la maestra: seis
  // recorridos completos en cada repintado, incluidos los de un gesto de zoom.
  const resumenProyecto = useMemo(() => {
    let sinMatch = 0, conSugerencia = 0, hayAltaConfianza = false;
    datosDelProyecto.forEach((r: ExtractedRow) => {
      if (!getMasterInfo(r.dni)) {
        sinMatch++;
        if (r.matchCandidates && r.matchCandidates.length > 0) conSugerencia++;
      }
      if (esVinculacionAutomatica(r) && r.matchConfidence != null && r.matchConfidence >= 0.92) {
        hayAltaConfianza = true;
      }
    });
    return { total: datosDelProyecto.length, sinMatch, conSugerencia, hayAltaConfianza };
  }, [datosDelProyecto, masterIndex]);

  // Acotada al proyecto activo igual que la tabla: la relectura es la operación que
  // gasta IA, así que no puede tocar renglones de un documento que no estás mirando.
  const filasSinCoincidencia = useMemo(
    () => datosDelProyecto.filter((r: ExtractedRow) => !getMasterInfo(r.dni) && !!r.bbox),
    [datosDelProyecto, masterData]
  );

  const displayedData = useMemo(() => {
    let result = [...datosDelProyecto];

    if (showOnlyErrors) {
      result = result.filter((r: ExtractedRow) => !getMasterInfo(r.dni) || r.id === editingRowId);
    }

    if (tableFilter) {
      const q = tableFilter.toLowerCase();
      result = result.filter((r: ExtractedRow) => r.nombre.toLowerCase().includes(q) || r.dni.toLowerCase().includes(q) || r.sourceFile.toLowerCase().includes(q));
    }
    Object.keys(activeFilters).forEach((key: string) => {
      const selectedValues = activeFilters[key];
      if (selectedValues.length > 0) {
        result = result.filter((r: ExtractedRow) => {
          if (key === "estado") {
            const master = getMasterInfo(r.dni);
            return selectedValues.includes(!!master ? "OK" : "FUERA");
          }
          return selectedValues.includes(r[key as keyof ExtractedRow] as string);
        });
      }
    });
    if (sortConfig) {
      result.sort((a: ExtractedRow, b: ExtractedRow) => {
        let valA: string;
        let valB: string;

        if (sortConfig.key === "estado") {
          valA = !!getMasterInfo(a.dni) ? "OK" : "FUERA";
          valB = !!getMasterInfo(b.dni) ? "OK" : "FUERA";
        } else {
          valA = (a[sortConfig.key as keyof ExtractedRow] ?? "").toString().toLowerCase();
          valB = (b[sortConfig.key as keyof ExtractedRow] ?? "").toString().toLowerCase();
        }

        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return result;
  }, [datosDelProyecto, tableFilter, sortConfig, activeFilters, showOnlyErrors, masterData, editingRowId]);

  // Filtros puestos ahora mismo sobre el proyecto. Se cuentan para dos cosas: no enseñar
  // el botón de limpiar cuando no hay nada que limpiar, y decir cuántos se van a quitar.
  //
  // Los filtros por columna son los más fáciles de olvidar: se ponen desde un embudo del
  // encabezado y, una vez cerrado el menú, la única pista de que siguen activos es un
  // icono teñido. Ver "Total: 106" y una tabla con 3 filas sin saber por qué es el
  // problema que resuelve esto.
  const filtrosActivos = useMemo(() => {
    let n = 0;
    if (tableFilter.trim()) n++;
    if (showOnlyErrors) n++;
    n += Object.keys(activeFilters).filter((k: string) => activeFilters[k].length > 0).length;
    return n;
  }, [tableFilter, showOnlyErrors, activeFilters]);

  // Limpia solo el contexto actual: los filtros de los demás proyectos siguen donde
  // estaban. No toca la selección de proyecto (no es un filtro de la vista, es el
  // proyecto) ni el orden, que reordena pero no oculta nada.
  const limpiarFiltros = () => {
    aplicarFiltros({ texto: "", columnas: {}, soloErrores: false });
    setOpenFilterMenu(null);
  };

  const toggleSort = (key: string) => setSortConfig((prev: { key: string, direction: 'asc' | 'desc' } | null) => (prev?.key === key && prev.direction === 'asc') ? { key, direction: 'desc' } : { key, direction: 'asc' });
  const toggleFilterValue = (column: string, value: string) => setActiveFilters((prev: { [key: string]: string[] }) => {
    const current = prev[column] || [];
    const updated = current.includes(value) ? current.filter((v: string) => v !== value) : [...current, value];
    return { ...prev, [column]: updated };
  });

  const getUniqueValues = (column: string): string[] => {
    if (column === "estado") return ["OK", "FUERA"];
    // Los desplegables de filtro solo ofrecen valores del proyecto a la vista: si no,
    // aparecerían opciones de otro documento que nunca devuelven ninguna fila.
    const values = datosDelProyecto.map((r: ExtractedRow) => r[column as keyof ExtractedRow] as string);
    return Array.from(new Set(values)).filter((v): v is string => !!v).sort();
  };

  const searchResults = useMemo(() => scoreMasterSearch(searchQuery, masterData), [searchQuery, masterData]);
  const viewerResults = useMemo(() => scoreMasterSearch(viewerQuery, masterData), [viewerQuery, masterData]);

  // Registro actualmente inspeccionado en el visor (para edición en vivo).
  const viewingRow = useMemo(
    () => (viewingImage?.rowId ? extractedData.find((r) => r.id === viewingImage.rowId) || null : null),
    [viewingImage, extractedData]
  );
  const viewingRowMaster = viewingRow ? getMasterInfo(viewingRow.dni) : undefined;

  // Cola de revisión del visor: los registros sin match, en el orden del documento.
  // Se incluye el que se está viendo aunque ya lo hayas resuelto, para que no se salga
  // de la lista bajo los pies al corregir su DNI y siga habiendo un "siguiente".
  // Acotada al proyecto activo: con un documento aislado, "siguiente" no debe saltar a
  // un renglón de otro documento que ni siquiera está en la tabla.
  const viewerQueue = useMemo(
    () => datosDelProyecto.filter((r) => !getMasterInfo(r.dni) || r.id === viewingImage?.rowId),
    [datosDelProyecto, masterData, viewingImage?.rowId]
  );
  const viewerQueueIdx = viewingRow ? viewerQueue.findIndex((r) => r.id === viewingRow.id) : -1;
  const goToQueue = (delta: number) => {
    const next = viewerQueue[viewerQueueIdx + delta];
    if (next) handleViewRow(next);
  };

  const applyDniToRow = (rowId: string, dni: string, method: MatchMethod = "MANUAL", confidence?: number) => {
    setExtractedData((prev) => prev.map((r) => (r.id === rowId ? { ...r, dni, method, matchConfidence: confidence } : r)));
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-800 font-sans overflow-hidden relative">
      
      {/* Backdrop para móviles */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setIsMobileMenuOpen(false)}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 md:hidden"
          />
        )}
      </AnimatePresence>

      <aside className={`fixed inset-y-0 left-0 z-50 transform ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 w-[300px] ${isSidebarCollapsed ? 'md:w-0 md:border-r-0 md:shadow-none' : 'md:w-[360px]'} flex-shrink-0 bg-white border-r border-slate-200 flex flex-col items-stretch overflow-hidden shadow-2xl md:shadow-xl transition-all duration-300 ease-in-out`}>
        {/* Ancho fijo interior: evita que el contenido se comprima mientras el panel se colapsa. */}
        <div className="w-[300px] md:w-[360px] h-full flex flex-col flex-shrink-0">
        <div className="px-6 py-6 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 text-blue-600 rounded-lg"><FileDigit size={24} /></div>
            <div>
              <h1 className="font-semibold text-lg leading-tight text-slate-900">{APP_NAME}</h1>
              <p className="text-xs text-slate-500 font-medium tracking-wide uppercase">{APP_SUBTITLE}</p>
            </div>
          </div>
          <button className="md:hidden p-2 text-slate-400 hover:text-slate-600 bg-slate-50 rounded-full" onClick={() => setIsMobileMenuOpen(false)}>
            <X size={20} />
          </button>
          <button
            className="hidden md:flex p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 bg-slate-50 rounded-full transition-colors flex-shrink-0"
            onClick={() => setIsSidebarCollapsed(true)}
            title="Ocultar panel lateral"
          >
            <PanelLeftClose size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 scrollbar-hide">
          <div className="w-full border-2 border-dashed border-slate-300 rounded-2xl bg-slate-50/50 hover:bg-blue-50/50 hover:border-blue-400 transition-colors cursor-pointer group flex flex-col items-center justify-center p-8 mb-6" onClick={() => fileInputRef.current?.click()}>
            <div className="bg-white p-3 rounded-full shadow-sm text-slate-400 group-hover:text-blue-500 mb-3 transition-colors"><Upload size={24} /></div>
            <p className="text-sm font-medium text-slate-700 mb-1 text-center">Añadir documentos</p>
            <input type="file" multiple accept="image/*,application/pdf" className="hidden" ref={fileInputRef} onChange={(e) => handleFilesAdded(e.target.files)} />
          </div>
          <AnimatePresence>
            {uploadProgress && (
              <motion.div
                initial={{ opacity: 0, y: -8, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -8, height: 0 }}
                className="mb-4 overflow-hidden"
              >
                <div className="p-4 rounded-2xl border border-blue-200 bg-blue-50/70">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <Loader2 size={14} className="text-blue-600 animate-spin shrink-0" />
                      <p className="text-xs font-semibold text-slate-800 truncate">{uploadProgress.archivo}</p>
                    </div>
                    <span className="text-sm font-black text-blue-600 tabular-nums shrink-0">{uploadProgress.pct}%</span>
                  </div>

                  <div className="w-full h-2 bg-blue-100 rounded-full overflow-hidden mt-2">
                    <motion.div
                      className="h-full bg-blue-600 rounded-full"
                      animate={{ width: `${uploadProgress.pct}%` }}
                      transition={{ ease: "easeOut", duration: 0.25 }}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <p className="text-[10px] text-slate-500 truncate">{uploadProgress.fase}</p>
                    {uploadProgress.total > 1 && (
                      <p className="text-[10px] font-bold text-slate-400 shrink-0">
                        {uploadProgress.indice}/{uploadProgress.total} archivos
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="space-y-3">
            {files.map((f) => {
              const seleccionado = f.id === activeFileId;
              const nFilas = extractedData.filter((r: ExtractedRow) => r.fileId === f.id).length;
              const estado = estadoDe(f);
              return (
              <div
                key={f.id}
                // Un clic aísla el proyecto; volver a hacer clic en el mismo vuelve a
                // mostrarlos todos, así que no hace falta un botón de "quitar filtro".
                onClick={() => setActiveFileId(seleccionado ? null : f.id)}
                onDoubleClick={() => handleViewSource(f.name)}
                title={seleccionado ? "Clic para volver a ver todos los documentos" : `Ver solo los datos de ${nombreProyecto(f)}`}
                className={`group relative flex items-center p-3 rounded-xl border shadow-sm hover:shadow-md transition-all cursor-pointer select-none ${
                  seleccionado ? "border-blue-500 bg-blue-50 ring-2 ring-blue-500/30" : "border-slate-200 bg-white"
                }`}
              >
                <div className={`h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center overflow-hidden border ${seleccionado ? "border-blue-300 bg-blue-100 text-blue-600" : "border-slate-200 bg-slate-100 text-slate-500"}`}>
                  {f.previewUrl ? <img src={f.previewUrl} alt="" className="object-cover w-full h-full" /> : <FileText size={20} />}
                </div>
                <div className="ml-3 flex-1 min-w-0 pr-8">
                  {/* stopPropagation en todo: sin él, escribir dentro de la caja
                      seleccionaría y deseleccionaría el proyecto con cada clic. */}
                  <input
                    value={projectTitles[f.id] ?? ""}
                    onChange={(e) => setProjectTitles(prev => ({ ...prev, [f.id]: e.target.value }))}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }}
                    placeholder="Escribe un título…"
                    maxLength={60}
                    title="Título solo para identificarlo aquí: no se guarda ni se envía a Sheets"
                    className={`w-full bg-transparent text-sm font-semibold outline-none truncate rounded px-1 -ml-1 border border-transparent transition-colors placeholder:font-normal placeholder:italic ${
                      seleccionado
                        ? "text-blue-900 placeholder:text-blue-400/70 hover:border-blue-300 focus:border-blue-500 focus:bg-white"
                        : "text-slate-800 placeholder:text-slate-400 hover:border-slate-300 focus:border-blue-500 focus:bg-white"
                    }`}
                  />
                  <p className={`text-[10px] truncate ${seleccionado ? "text-blue-600" : "text-slate-400"}`}>
                    <span className="font-mono">{f.name}</span>
                    {estado === "listo" && <span className="font-semibold"> · {nFilas} fila(s)</span>}
                  </p>
                  {/* El estado va en la tarjeta, no solo en el botón: con varios proyectos
                      hay que poder ver de un vistazo cuál falta por procesar. */}
                  <span className={`inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                    estado === "listo" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : estado === "procesando" ? "bg-blue-50 text-blue-700 border-blue-200"
                      : estado === "error" ? "bg-red-50 text-red-700 border-red-200"
                      : "bg-slate-100 text-slate-500 border-slate-200"
                  }`}>
                    {estado === "listo" ? <><Check size={9} /> Extraído</>
                      : estado === "procesando" ? <><Loader2 size={9} className="animate-spin" /> Extrayendo…</>
                      : estado === "error" ? <><AlertCircle size={9} /> Falló</>
                      : "Sin extraer"}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    // Quitar el documento se lleva su extracción: son proyectos
                    // independientes, y dejar filas huérfanas de un archivo que ya no
                    // está las volvería inexportables y sin forma de abrir su origen.
                    // Se avisa solo si hay algo que perder.
                    if (nFilas > 0 && !confirm(`¿Quitar ${nombreProyecto(f)}?\n\nSe eliminarán también sus ${nFilas} fila(s) extraída(s). Los demás proyectos no se tocan.`)) return;
                    if (activeFileId === f.id) setActiveFileId(null);
                    setExtractedData(prev => prev.filter((r: ExtractedRow) => r.fileId !== f.id));
                    // El título y el estado mueren con el documento: si no, un archivo
                    // nuevo podría heredarlos en caso de repetirse el id.
                    setProjectTitles(prev => { const { [f.id]: _, ...resto } = prev; return resto; });
                    setEstadoProyectos(prev => { const { [f.id]: _, ...resto } = prev; return resto; });
                    setFiltrosPorProyecto(prev => { const { [f.id]: _, ...resto } = prev; return resto; });
                    setFiles(prev => prev.filter(x => x.id !== f.id));
                  }}
                  className="absolute right-3 p-2 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                ><X size={16} /></button>
              </div>
              );
            })}
          </div>
        </div>
        <div className="p-6 border-t border-slate-200 bg-white">
          {isApiKeyMissing && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2 text-amber-700">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <p className="text-[10px] font-medium leading-tight">Configura VITE_GEMINI_API_KEY en Vercel</p>
            </div>
          )}

          {/* Estado de la lista maestra: si no cargó, todo saldría FUERA sin explicación */}
          {masterStatus === "error" ? (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2 text-red-700">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[11px] font-bold leading-tight">No se pudo cargar la lista maestra</p>
                <p className="text-[10px] leading-snug mt-0.5 opacity-90">Sin ella no hay con quién comparar y todos los registros saldrán FUERA.</p>
                <button onClick={() => cargarMaestra()} className="mt-2 text-[10px] font-bold uppercase tracking-wider bg-red-600 text-white px-2.5 py-1 rounded-lg hover:bg-red-700 transition-colors">
                  Reintentar
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-2 text-[10px] font-medium text-slate-500">
              {masterStatus === "cargando" ? (
                <><Loader2 size={12} className="animate-spin text-blue-500 shrink-0" /> Cargando lista maestra…</>
              ) : (
                <><CheckCircle2 size={12} className="text-emerald-500 shrink-0" /> Lista maestra: {masterData.length} personas</>
              )}
            </div>
          )}
          {/* El botón actúa sobre UN proyecto: el seleccionado, o el único cargado. Se
              bloquea mientras se cargan documentos (aún no están en `files`) y también
              cuando el proyecto ya está extraído, para no repetir el gasto de una
              extracción que ya se pagó. */}
          {(() => {
            const cargando = !!uploadProgress;
            const ocupado = status === "processing" || estadoObjetivo === "procesando";
            const yaExtraido = estadoObjetivo === "listo";
            const bloqueado = files.length === 0 || !proyectoObjetivo || ocupado || yaExtraido || isApiKeyMissing || cargando;

            const etiqueta = cargando ? "Cargando documentos…"
              : ocupado ? "Extrayendo…"
              : files.length === 0 ? "Iniciar Extracción"
              : !proyectoObjetivo ? "Elige un proyecto en la lista"
              : yaExtraido ? "Proyecto ya extraído"
              : estadoObjetivo === "error" ? `Reintentar ${nombreProyecto(proyectoObjetivo)}`
              : `Extraer ${nombreProyecto(proyectoObjetivo)}`;

            return (
              <>
                <button
                  disabled={bloqueado}
                  onClick={() => executeExtraction()}
                  title={proyectoObjetivo ? `Se procesará únicamente ${proyectoObjetivo.name}` : "Selecciona un documento en la lista para extraerlo"}
                  className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white shadow-sm font-semibold rounded-xl py-3.5 transition-all text-sm"
                >
                  {ocupado || cargando ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
                  <span className="truncate">{etiqueta}</span>
                </button>
                {/* Volver a extraer sigue siendo posible, pero deja de ser el camino por
                    defecto: hay que pedirlo, porque cuesta una llamada al modelo y
                    descarta las correcciones manuales de ese proyecto. */}
                {yaExtraido && !ocupado && (
                  <button
                    onClick={() => {
                      if (confirm(`¿Volver a extraer ${nombreProyecto(proyectoObjetivo!)}?\n\nSe descartarán sus filas actuales y las correcciones hechas sobre ellas. Los demás proyectos no se tocan.`)) {
                        executeExtraction(proyectoObjetivo);
                      }
                    }}
                    className="w-full mt-2 text-[11px] font-semibold text-slate-500 hover:text-blue-600 transition-colors"
                  >
                    Volver a extraer este proyecto
                  </button>
                )}
              </>
            );
          })()}
        </div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col bg-[#FAFAFA] w-full">
        {/* Cabecera Móvil */}
        <div className="md:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm z-30 shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2 text-slate-600 bg-slate-50 rounded-lg">
              <Menu size={24} />
            </button>
            <div className="flex items-center gap-2">
              <FileDigit size={20} className="text-blue-600" />
              <h1 className="font-bold text-slate-800">{APP_NAME}</h1>
            </div>
          </div>
        </div>

        {/* `flex-wrap` en lugar de scroll horizontal: si los controles no caben en el
            ancho disponible bajan a otra línea. Un scroll lateral escondía botones sin
            avisar, y el header es justo donde tienen que verse todos de un vistazo. */}
        <header className="flex-shrink-0 bg-white border-b border-slate-200 px-4 md:px-8 py-4 flex flex-col lg:flex-row flex-wrap items-start lg:items-center justify-between shadow-sm z-10 gap-3">
          <div className="flex items-center gap-4 w-full lg:w-auto justify-between">
            <h2 className="text-lg font-semibold text-slate-800 hidden md:flex items-center gap-3">
              {isSidebarCollapsed && (
                <button
                  onClick={() => setIsSidebarCollapsed(false)}
                  title="Mostrar panel lateral"
                  className="p-2 -ml-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors flex-shrink-0"
                >
                  <PanelLeftOpen size={20} />
                </button>
              )}
              Panel de Resultados
              {/* Con un proyecto aislado, esta pastilla es la única señal en la zona
                  derecha de que lo que se ve —y lo que se exporta— no es todo. */}
              {proyectoActivo && (
                <button
                  onClick={() => setActiveFileId(null)}
                  title="Quitar el filtro y volver a ver todos los documentos"
                  className="flex items-center gap-1.5 text-xs font-bold bg-blue-100 text-blue-700 border border-blue-300 px-2.5 py-1 rounded-full hover:bg-blue-200 transition-colors max-w-[16rem]"
                >
                  <Layers size={12} className="shrink-0" />
                  <span className="truncate">{nombreProyecto(proyectoActivo)}</span>
                  <X size={12} className="shrink-0" />
                </button>
              )}
              {resumenProyecto.total > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">Total: {resumenProyecto.total}</span>
                  {resumenProyecto.sinMatch > 0 && (
                    <button
                      onClick={() => setShowOnlyErrors(!showOnlyErrors)}
                      className={`text-xs font-bold px-2.5 py-1 rounded-full border transition-colors ${showOnlyErrors ? 'bg-red-600 text-white border-red-700' : 'bg-red-100 text-red-600 border-red-200 hover:bg-red-200'}`}
                    >
                      ⚠️ Sin Match: {resumenProyecto.sinMatch}
                    </button>
                  )}
                  {resumenProyecto.conSugerencia > 0 && (
                    <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full border border-amber-200">
                      💡 Sugerencias: {resumenProyecto.conSugerencia}
                    </span>
                  )}
                </div>
              )}
            </h2>
            <div className="md:hidden flex items-center gap-2">
              <span className="font-semibold text-slate-700 text-sm truncate max-w-[9rem]">{proyectoActivo ? nombreProyecto(proyectoActivo) : "Resultados"}</span>
              {proyectoActivo && (
                <button onClick={() => setActiveFileId(null)} title="Ver todos los documentos" className="p-1 rounded-full bg-blue-100 text-blue-700 border border-blue-300">
                  <X size={10} />
                </button>
              )}
              {resumenProyecto.total > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{resumenProyecto.total}</span>
                  {resumenProyecto.sinMatch > 0 && (
                    <button
                      onClick={() => setShowOnlyErrors(!showOnlyErrors)}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-colors ${showOnlyErrors ? 'bg-red-600 text-white border-red-700' : 'bg-red-100 text-red-600 border-red-200'}`}
                    >
                      {resumenProyecto.sinMatch} ⚠️
                    </button>
                  )}
                </div>
              )}
            </div>
            {resumenProyecto.total > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={tryFuzzyMatch} title="Vincula los registros con la lista maestra comparando nombre y DNI (cálculo local, no usa IA)" className="flex items-center gap-2 px-3 py-2 text-[10px] md:text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md active:scale-95 whitespace-nowrap">
                  <Link2 size={14} /> <span className="hidden md:inline">Vincular</span><span className="md:hidden">Vincular</span>
                </button>
                {resumenProyecto.hayAltaConfianza && (
                  <button onClick={acceptAllHighConfidence} title="Da por buenas todas las coincidencias con confianza alta (≥92%)" className="flex items-center gap-1.5 px-3 py-2 text-[10px] md:text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-full transition-all shadow-md active:scale-95 whitespace-nowrap">
                    <Check size={14} /> <span className="hidden md:inline">Aceptar altas</span><span className="md:hidden">✓ AC</span>
                  </button>
                )}
                {/* Último recurso: solo aparece si quedan filas sin resolver, y dice
                    cuántas va a releer para que el gasto de IA sea siempre explícito. */}
                {filasSinCoincidencia.length > 0 && (
                  <button
                    onClick={handleRelectura}
                    disabled={relecturaBusy}
                    title={`Recorta y amplía ${Math.min(filasSinCoincidencia.length, MAX_RELECTURA)} renglón(es) sin coincidencia y los relee de uno en uno`}
                    className="flex items-center gap-1.5 px-3 py-2 text-[10px] md:text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed rounded-full transition-all shadow-md active:scale-95 whitespace-nowrap"
                  >
                    {relecturaBusy
                      ? <Loader2 size={14} className="animate-spin" />
                      : <ZoomIn size={14} />}
                    <span className="hidden md:inline">
                      {relecturaBusy ? "Releyendo…" : `Releer ${Math.min(filasSinCoincidencia.length, MAX_RELECTURA)}`}
                    </span>
                    <span className="md:hidden">{Math.min(filasSinCoincidencia.length, MAX_RELECTURA)}🔍</span>
                  </button>
                )}
                {/* Solo aparece si hay algo que limpiar, y dice cuántos filtros quita.
                    Los de columna se ponen desde un embudo del encabezado y, con el menú
                    cerrado, la única pista de que siguen puestos es un icono teñido. */}
                {filtrosActivos > 0 && (
                  <button
                    onClick={limpiarFiltros}
                    title={`Quita los ${filtrosActivos} filtro(s) puestos en este proyecto. No afecta a los demás proyectos ni borra ningún dato.`}
                    className="flex items-center gap-1.5 px-3 py-2 text-[10px] md:text-xs font-bold text-slate-600 bg-white border border-slate-300 hover:bg-slate-50 hover:text-slate-800 rounded-full transition-all shadow-sm active:scale-95 whitespace-nowrap"
                  >
                    <FilterX size={14} />
                    <span className="hidden md:inline">Limpiar filtros ({filtrosActivos})</span>
                    <span className="md:hidden">{filtrosActivos}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          {datosDelProyecto.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
              {/* El filtro cede ancho antes que los botones: es el único control que
                  sigue siendo usable estrecho, así que absorbe él la falta de espacio. */}
              <div className="relative flex-1 min-w-[7rem] lg:flex-none lg:w-40">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input placeholder="Filtro..." value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs outline-none focus:border-blue-400 focus:bg-white transition-all" />
              </div>
              <button onClick={async () => {
                const csv = getCsvString();
                // Solo cabecera = ninguna fila tiene coincidencia en la maestra. Copiar
                // eso en silencio es indistinguible de un botón roto.
                if (csv.split("\n").length <= 1) {
                  mostrarToast("error", "No hay filas con coincidencia en la maestra para copiar.");
                  return;
                }
                const ok = await copiarTexto(csv);
                mostrarToast(
                  ok ? "ok" : "error",
                  ok ? `${csv.split("\n").length - 1} fila(s) copiadas al portapapeles.`
                     : "No se pudo copiar. Usa el botón Descargar."
                );
              }} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs md:text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"><Copy size={14} /> <span className="hidden md:inline">Copiar</span></button>
              <button onClick={() => {
                const blob = new Blob([getCsvString()], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                // El nombre lleva el proyecto: descargar dos documentos seguidos dejaba
                // dos "participantes.csv" indistinguibles en la carpeta de descargas.
                const nombreCsv = proyectoActivo
                  ? `participantes-${fileStem(proyectoActivo.name).replace(/[^a-z0-9]+/gi, "-")}.csv`
                  : "participantes.csv";
                link.href = url; link.setAttribute("download", nombreCsv);
                // Algunos navegadores ignoran el click si el enlace no está en el DOM.
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
              }} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs md:text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 transition-colors"><Download size={14} /> <span className="hidden md:inline">Descargar</span></button>
              <button
                disabled={sending || displayedData.length === 0}
                onClick={() => { setIdRefInput(""); setSheetsModal(true); }}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs md:text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
                <span className="hidden md:inline">Enviar a Sheets</span><span className="md:hidden">Sheets</span>
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-8 relative scrollbar-hide">
          {status === "error" && errorMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-3 text-red-700 shadow-sm"
            >
              <AlertCircle className="flex-shrink-0 mt-0.5" size={20} />
              <div>
                <p className="text-sm font-bold">Error de Extracción</p>
                <p className="text-xs mt-1 leading-relaxed opacity-90 font-mono bg-white/50 p-2 rounded-lg border border-red-100 mt-2">{errorMessage}</p>
                <button 
                  onClick={() => setStatus("idle")}
                  className="mt-3 text-[10px] font-bold uppercase tracking-wider bg-red-700 text-white px-3 py-1.5 rounded-lg hover:bg-red-800 transition-colors"
                >
                  Entendido
                </button>
              </div>
            </motion.div>
          )}

          {/* Proyecto seleccionado y sin filas. Con proyectos independientes el caso
              normal es que aún no se haya extraído, así que el panel dice qué falta
              hacer en vez de dejar un hueco en blanco. */}
          {proyectoActivo && datosDelProyecto.length === 0 && status !== "processing" && (
            <div className="w-full flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
              <Layers size={28} className="opacity-40" />
              <p className="text-sm font-semibold text-slate-600">{nombreProyecto(proyectoActivo)}</p>
              {estadoDe(proyectoActivo) === "listo" ? (
                <p className="text-xs max-w-xs text-center">
                  La extracción terminó sin devolver ninguna fila para este documento.
                </p>
              ) : estadoDe(proyectoActivo) === "error" ? (
                <p className="text-xs max-w-xs text-center text-red-500">
                  La extracción de este proyecto falló. Puedes reintentarla desde el panel lateral.
                </p>
              ) : (
                <>
                  <p className="text-xs max-w-xs text-center">
                    Este proyecto todavía no se ha extraído.
                  </p>
                  <button
                    onClick={() => executeExtraction(proyectoActivo)}
                    disabled={isApiKeyMissing || !!uploadProgress}
                    className="mt-1 flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 rounded-full transition-colors"
                  >
                    <Play size={12} fill="currentColor" /> Extraer {nombreProyecto(proyectoActivo)}
                  </button>
                </>
              )}
            </div>
          )}

          {datosDelProyecto.length > 0 && (
            <div className="w-full flex flex-col mb-20 md:mb-6">

              {/* VISTA MÓVIL: TARJETAS */}
              <div className="md:hidden flex flex-col gap-4">
                {displayedData.map((row) => {
                  const master = getMasterInfo(row.dni);
                  const isValid = !!master;
                  const badge = methodBadge(row);
                  return (
                    <div key={row.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col gap-3 relative overflow-hidden">
                      <div className={`absolute top-0 left-0 w-1.5 h-full ${isValid ? 'bg-emerald-500' : 'bg-red-500'}`}></div>
                      <div className="flex items-center justify-between pl-2 border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">#{row.nro}</span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isValid ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{isValid ? "VÁLIDO" : "SIN MATCH"}</span>
                        </div>
                        <button onClick={() => handleViewRow(row)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors text-xs font-bold"><Eye size={14} /> Ver Doc</button>
                      </div>
                      
                      <div className="pl-2 flex flex-col gap-2">
                        <div>
                          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-0.5">Apellidos y Nombres (Extraído)</p>
                          <p className="text-sm font-semibold text-slate-800 leading-tight">{highlightMatch(row.nombre, tableFilter)}</p>
                        </div>
                        
                        <div>
                          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-0.5">DNI</p>
                          <input type="text" value={row.dni} onChange={(e) => {
                            const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: e.target.value, method: "MANUAL" as MatchMethod } : r);
                            setExtractedData(updated);
                          }} onFocus={() => setEditingRowId(row.id)} onBlur={() => setEditingRowId(null)} className={`w-full max-w-[200px] px-3 py-1.5 rounded-lg border outline-none transition-all font-mono text-sm ${isValid ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`} />
                        </div>

                        {isValid && (
                          <div className="mt-2 bg-slate-50 rounded-xl p-3 border border-slate-100">
                            <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider mb-1 flex items-center gap-1"><Database size={10}/> Datos Maestros</p>
                            <p className="text-xs font-semibold text-slate-700 truncate">{master.nombre}</p>
                            <div className="flex gap-2 mt-1">
                                <span className="text-[10px] bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-500 font-mono">{master.dni}</span>
                                <span className="text-[10px] bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-500 truncate">{master.cargo}</span>
                            </div>
                          </div>
                        )}
                        
                        {!isValid && row.matchCandidates && row.matchCandidates.length > 0 && (
                          <div className="relative">
                            <button
                              onClick={() => setActiveCandidateRow(activeCandidateRow === row.id ? null : row.id)}
                              className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg hover:bg-amber-100 transition-colors"
                            >
                              💡 {row.matchCandidates.length} sugerencia{row.matchCandidates.length > 1 ? "s" : ""}
                            </button>
                            {activeCandidateRow === row.id && (
                              <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-amber-200 rounded-xl shadow-lg p-2 min-w-[240px]">
                                {row.matchCandidates.map((c, ci) => (
                                  <button key={ci} onClick={() => {
                                    const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: c.master.dni, method: "AUTO" as MatchMethod, matchConfidence: c.score } : r);
                                    setExtractedData(updated);
                                    setActiveCandidateRow(null);
                                  }} className="w-full text-left px-3 py-2 hover:bg-amber-50 rounded-lg transition-colors">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-xs font-semibold text-slate-800 truncate">{c.master.nombre}</span>
                                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${confidenceLevel(c.score) === "high" ? "bg-emerald-100 text-emerald-700" : confidenceLevel(c.score) === "medium" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>{Math.round(c.score * 100)}%</span>
                                    </div>
                                    <span className="text-[10px] text-slate-400 font-mono">{c.master.dni}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center justify-between mt-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {row.filaDoc && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-100 text-indigo-700 border border-indigo-200 shrink-0">
                                <FileDigit size={10} /> Fila {row.filaDoc}
                              </span>
                            )}
                            <span className="text-[9px] text-slate-400 italic truncate max-w-[120px]">{row.sourceFile}</span>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${badge.className}`}>
                            {badge.label}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* VISTA ESCRITORIO: TABLA */}
              <div className="hidden md:flex bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex-col">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm text-slate-600 border-collapse table-fixed">
                    <thead className="text-[11px] text-slate-500 bg-slate-50/80 sticky top-0 uppercase font-bold tracking-wider z-30">
                      <tr>
                        <th className="px-4 py-4 border-b border-slate-200 relative group/th" style={{ width: colWidths.nro, minWidth: 50 }}>Nro<div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400 opacity-0 group-hover/th:opacity-100 transition-opacity z-10" onMouseDown={(e) => { e.preventDefault(); handleResizeStart('nro', e.clientX, colWidths.nro); }} /></th>
                        <th className="px-4 py-4 border-b border-slate-200 text-center relative group/th" style={{ width: colWidths.ver, minWidth: 50 }}>Ver<div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400 opacity-0 group-hover/th:opacity-100 transition-opacity z-10" onMouseDown={(e) => { e.preventDefault(); handleResizeStart('ver', e.clientX, colWidths.ver); }} /></th>
                        <HeaderCell label="Apellidos y Nombres" colKey="nombre" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("nombre")} isFiltered={(activeFilters["nombre"]?.length || 0) > 0} width={colWidths.nombre} onResizeStart={handleResizeStart} />
                        <HeaderCell label="DNI" colKey="dni" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("dni")} isFiltered={(activeFilters["dni"]?.length || 0) > 0} width={colWidths.dni} onResizeStart={handleResizeStart} />
                        <HeaderCell label="Estado" colKey="estado" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("estado")} isFiltered={(activeFilters["estado"]?.length || 0) > 0} center width={colWidths.estado} onResizeStart={handleResizeStart} />
                        <HeaderCell label="Método" colKey="method" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("method")} isFiltered={(activeFilters["method"]?.length || 0) > 0} center width={colWidths.method} onResizeStart={handleResizeStart} />
                        <HeaderCell label="Origen" colKey="sourceFile" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("sourceFile")} isFiltered={(activeFilters["sourceFile"]?.length || 0) > 0} width={colWidths.sourceFile} onResizeStart={handleResizeStart} />
                        <HeaderCell label="Fila Doc" colKey="filaDoc" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("filaDoc")} isFiltered={(activeFilters["filaDoc"]?.length || 0) > 0} center width={colWidths.filaDoc} onResizeStart={handleResizeStart} />
                        <th className="px-6 py-4 border-b border-slate-200 border-l border-slate-200 text-blue-600 relative group/th" style={{ width: colWidths.dniSheets, minWidth: 50 }}>DNI Sheets<div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400 opacity-0 group-hover/th:opacity-100 transition-opacity z-10" onMouseDown={(e) => { e.preventDefault(); handleResizeStart('dniSheets', e.clientX, colWidths.dniSheets); }} /></th>
                        <th className="px-6 py-4 border-b border-slate-200 text-blue-600 relative group/th" style={{ width: colWidths.nombreOficial, minWidth: 50 }}>Nombre Oficial<div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400 opacity-0 group-hover/th:opacity-100 transition-opacity z-10" onMouseDown={(e) => { e.preventDefault(); handleResizeStart('nombreOficial', e.clientX, colWidths.nombreOficial); }} /></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono">
                      {displayedData.map((row) => {
                        const master = getMasterInfo(row.dni);
                        const isValid = !!master;
                        const badge = methodBadge(row);
                        return (
                          <tr key={row.id} className="hover:bg-slate-50/50 transition-colors group/row">
                            <td className="px-4 py-3 text-slate-400">{row.nro}</td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => handleViewRow(row)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"><Eye size={16} /></button>
                            </td>
                            <td className="px-6 py-3 truncate max-w-[180px] text-slate-800">{highlightMatch(row.nombre, tableFilter)}</td>
                            {/* px-2 en vez de px-6: el margen de la celda se lo comía el DNI */}
                            <td className="px-2 py-3">
                              <input type="text" value={row.dni} title={row.dni} onChange={(e) => {
                                const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: e.target.value, method: "MANUAL" as MatchMethod } : r);
                                setExtractedData(updated);
                              }} onFocus={() => setEditingRowId(row.id)} onBlur={() => setEditingRowId(null)} className={`w-full min-w-[104px] px-2 py-1 rounded border outline-none transition-all font-mono text-sm tracking-tight ${isValid ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`} />
                              {/* Resaltado visual en el input del DNI */}
                              {tableFilter && row.dni.toLowerCase().includes(tableFilter.toLowerCase()) && (
                                <div style={{ position: 'absolute', right: 8, top: 8, pointerEvents: 'none' }}>
                                  <mark style={{ background: '#ffe066', padding: 0 }}>{tableFilter}</mark>
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-bold ${isValid ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{isValid ? "OK" : "FUERA"}</span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <div className="flex flex-col items-center gap-1">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold border ${badge.className}`}>
                                  {badge.label}
                                </span>
                                {!isValid && row.matchCandidates && row.matchCandidates.length > 0 && (
                                  <div className="relative">
                                    <button
                                      onClick={() => setActiveCandidateRow(activeCandidateRow === row.id ? null : row.id)}
                                      className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded hover:bg-amber-100 transition-colors"
                                    >
                                      💡 {row.matchCandidates.length}
                                    </button>
                                    {activeCandidateRow === row.id && (
                                      <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-amber-200 rounded-xl shadow-lg p-2 min-w-[260px]">
                                        {row.matchCandidates.map((c, ci) => (
                                          <button key={ci} onClick={() => {
                                            const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: c.master.dni, method: "AUTO" as MatchMethod, matchConfidence: c.score } : r);
                                            setExtractedData(updated);
                                            setActiveCandidateRow(null);
                                          }} className="w-full text-left px-3 py-2 hover:bg-amber-50 rounded-lg transition-colors">
                                            <div className="flex items-center justify-between gap-2">
                                              <span className="text-xs font-semibold text-slate-800 truncate">{c.master.nombre}</span>
                                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${confidenceLevel(c.score) === "high" ? "bg-emerald-100 text-emerald-700" : confidenceLevel(c.score) === "medium" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>{Math.round(c.score * 100)}%</span>
                                            </div>
                                            <span className="text-[10px] text-slate-400 font-mono">{c.master.dni}</span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-3 text-[10px] text-slate-400 italic truncate max-w-[100px]">{row.sourceFile}</td>
                            <td className="px-4 py-3 text-center">
                              {row.filaDoc ? (
                                <button
                                  onClick={() => handleViewRow(row)}
                                  title={`Identificado en la fila ${row.filaDoc} de ${row.sourceFile || "el documento"}`}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700 border border-indigo-200 hover:bg-indigo-200 transition-colors"
                                >
                                  <FileDigit size={11} /> Fila {row.filaDoc}
                                </button>
                              ) : (
                                <span className="text-slate-300 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-6 py-3 bg-slate-50/30 border-l border-slate-100 text-slate-500 italic">{master ? master.dni : "---"}</td>
                            <td className="px-6 py-3 bg-slate-50/30 text-slate-600">{master ? master.nombre : "---"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          )}

          {status === "processing" && (
            <div className="absolute inset-0 z-50 bg-white/60 backdrop-blur-sm flex flex-col items-center justify-center">
              <div className="bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 flex flex-col items-center gap-6 max-w-sm text-center">
                <div className="relative">
                  <div className="absolute inset-0 bg-blue-100 rounded-full animate-ping opacity-20" />
                  <div className="relative p-5 bg-blue-50 text-blue-600 rounded-full">
                    <Sparkles size={32} className="animate-pulse" />
                  </div>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-800 mb-2">Extrayendo Datos</h3>
                  <p className="text-sm text-slate-500 leading-relaxed">
                    {/* Se nombra el documento: ahora se procesa de uno en uno y conviene
                        que se vea cuál, sobre todo si hay varios en la lista. */}
                    Analizando <strong className="text-slate-700">{proyectoObjetivo ? nombreProyecto(proyectoObjetivo) : "el documento"}</strong>. Esto puede tomar unos segundos dependiendo de la complejidad…
                  </p>
                </div>
                <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ x: "-100%" }}
                    animate={{ x: "100%" }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                    className="w-1/2 h-full bg-blue-600 rounded-full"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <AnimatePresence>
          {openFilterMenu && (
            <div className="fixed inset-0 z-[100]" onClick={() => setOpenFilterMenu(null)}>
              <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="absolute bg-white rounded-xl shadow-2xl border border-slate-200 w-56 py-2 overflow-hidden" style={{ top: '150px', left: '400px' }} onClick={e => e.stopPropagation()}>
                <div className="px-4 py-2 border-b border-slate-100 flex justify-between items-center"><span className="text-[11px] font-bold text-slate-500 uppercase">Filtrar {openFilterMenu}</span><button onClick={() => setActiveFilters(prev => ({ ...prev, [openFilterMenu]: [] }))} className="text-[10px] text-blue-600 hover:underline">Limpiar</button></div>
                <div className="max-h-60 overflow-y-auto">
                  {getUniqueValues(openFilterMenu).map(val => (
                    <div key={val} className="px-4 py-2 hover:bg-slate-50 cursor-pointer flex items-center justify-between group" onClick={() => toggleFilterValue(openFilterMenu, val)}>
                      <span className="text-xs text-slate-700 truncate">{val}</span>
                      {(activeFilters[openFilterMenu] || []).includes(val) && <Check size={14} className="text-blue-600" />}
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>

      {/* Aviso cuando no se puede abrir el documento de una fila */}
      <AnimatePresence>
        {viewerError && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] max-w-[92vw] md:max-w-md bg-slate-900 text-white rounded-2xl shadow-2xl border border-white/10 px-4 py-3 flex items-start gap-3"
          >
            <AlertCircle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed flex-1">{viewerError}</p>
            <button onClick={() => setViewerError(null)} className="text-white/50 hover:text-white shrink-0 transition-colors"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* REIMAGINED ZOOM VIEWER */}
      <AnimatePresence>
        {viewingImage && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-8 select-none"
            onWheel={handleWheel}
          >
            {/* Header Controls */}
            <div className="absolute top-0 left-0 right-0 p-4 md:p-6 flex flex-wrap items-center justify-between bg-gradient-to-b from-black/60 via-black/40 to-transparent z-50 pointer-events-none gap-4">
              <div className="flex items-center gap-3 pointer-events-auto">
                <button onClick={() => setViewingImage(null)} className="md:hidden p-2.5 bg-white/10 backdrop-blur-xl text-white rounded-xl border border-white/20 shadow-2xl transition-all"><X size={24}/></button>
                <div className="hidden md:flex p-2.5 bg-blue-600 text-white rounded-xl shadow-lg"><ImageIcon size={20} /></div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-white font-semibold text-xs md:text-sm leading-tight truncate max-w-[150px] md:max-w-md">{viewingImage.name}</h3>
                  <p className="text-slate-300 text-[9px] md:text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 flex-wrap">
                    <span>Modo Inspección</span>
                    {viewingImage.totalPages > 1 && <span className="text-blue-300 normal-case tracking-normal">Pág {viewingImage.pagina}/{viewingImage.totalPages}</span>}
                    {viewingImage.fila && <span className="text-red-300 normal-case tracking-normal">Fila {viewingImage.fila}</span>}
                    {viewingImage.fila && !viewingImage.bbox && <span className="text-amber-300 normal-case tracking-normal">(sin ubicación exacta)</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 pointer-events-auto ml-auto">
                {viewingImage.bbox && (
                  <div className="flex items-center bg-white/10 backdrop-blur-xl rounded-xl md:rounded-2xl border border-white/20 p-1 mr-1 md:mr-2 shadow-2xl" title="Ajustar la marca una fila arriba/abajo si está desfasada">
                    <button onClick={() => setBboxNudge(n => n - 1)} className="p-1.5 md:p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg md:rounded-xl transition-all"><ArrowUp size={16} className="md:w-5 md:h-5"/></button>
                    <span className="px-1 text-[9px] md:text-[10px] font-mono font-bold text-red-300 uppercase tracking-wide select-none">Fila</span>
                    <button onClick={() => setBboxNudge(n => n + 1)} className="p-1.5 md:p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg md:rounded-xl transition-all"><ArrowDown size={16} className="md:w-5 md:h-5"/></button>
                  </div>
                )}
                <div className="flex items-center bg-white/10 backdrop-blur-xl rounded-xl md:rounded-2xl border border-white/20 p-1 mr-1 md:mr-2 shadow-2xl">
                  <button onClick={() => fijarVista({ zoom: zoomTargetRef.current / 1.2 }, true)} className="p-1.5 md:p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg md:rounded-xl transition-all"><ZoomOut size={16} className="md:w-5 md:h-5"/></button>
                  <div className="px-2 md:px-4 min-w-[50px] md:min-w-[70px] text-center"><span className="text-xs md:text-sm font-mono font-black text-blue-400">{(zoomLevel*100).toFixed(0)}%</span></div>
                  <button onClick={() => fijarVista({ zoom: zoomTargetRef.current * 1.2 }, true)} className="p-1.5 md:p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg md:rounded-xl transition-all"><ZoomIn size={16} className="md:w-5 md:h-5"/></button>
                </div>
                <button onClick={resetViewer} className="p-2 md:p-3 bg-white/10 backdrop-blur-xl text-white/80 hover:text-white hover:bg-white/10 rounded-xl md:rounded-2xl border border-white/20 shadow-2xl transition-all" title="Reiniciar vista"><RotateCcw size={16} className="md:w-5 md:h-5"/></button>
                <button onClick={() => setViewingImage(null)} className="hidden md:block ml-2 p-3 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white rounded-2xl border border-red-500/30 shadow-2xl transition-all"><X size={24}/></button>
              </div>
            </div>

            {/* Interaction Canvas */}
            <div
              className={`relative w-full h-full flex items-center justify-center overflow-hidden cursor-${isPanning ? 'grabbing' : 'grab'} touch-none transition-all ${viewingRow ? 'pb-[46vh] md:pb-0 md:pr-[396px]' : ''}`}
              onMouseDown={handlePanStart}
              onMouseMove={handlePanMove}
              onMouseUp={handlePanEnd}
              onMouseLeave={handlePanEnd}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {/* Transform directo en lugar de animate+spring de motion.
                  El muelle re-arrancaba una animación de ~400 ms en CADA paso de rueda,
                  así que el zoom siempre iba por detrás del gesto y el arrastre "flotaba"
                  en vez de seguir al cursor. Un gesto continuo no debe animarse: la
                  posición del dedo o de la rueda ya es la animación.

                  `will-change` SOLO durante el gesto. Dejarlo fijo mantenía la capa
                  rasterizada a la escala inicial y el navegador se limitaba a estirar
                  esos píxeles: por eso al ampliar se veía borroso. Al soltarlo, Chrome
                  vuelve a rasterizar desde el original a la escala actual y la imagen
                  recupera el detalle. */}
              <div
                className="relative pointer-events-none"
                style={{
                  width: "fit-content",
                  height: "fit-content",
                  lineHeight: 0,
                  transform: `translate3d(${panOffset.x}px, ${panOffset.y}px, 0) scale(${zoomLevel})`,
                  willChange: gestoActivo ? "transform" : "auto",
                }}
              >
                <img
                  src={viewingImage.url}
                  draggable={false}
                  className="max-w-[88vw] max-h-[85vh] object-contain shadow-[0_0_100px_rgba(0,0,0,0.5)] rounded-sm block"
                />
                {viewingImage.bbox && (() => {
                  const rowH = viewingImage.bbox.ymax - viewingImage.bbox.ymin;
                  const shift = bboxNudge * rowH;
                  const top = Math.max(0, viewingImage.bbox.ymin + shift);
                  return (
                  <motion.div
                    className="absolute border-2 border-red-500 rounded-[2px] bg-red-500/10"
                    style={{
                      left: `${viewingImage.bbox.xmin / 10}%`,
                      top: `${top / 10}%`,
                      width: `${(viewingImage.bbox.xmax - viewingImage.bbox.xmin) / 10}%`,
                      height: `${rowH / 10}%`,
                      boxShadow: "0 0 0 9999px rgba(2,6,23,0.55)",
                    }}
                    initial={{ opacity: 0.5 }}
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
                  >
                    {viewingImage.fila && (
                      <span
                        className="absolute left-0 bg-red-500 text-white text-[7px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shadow-lg"
                        style={{ bottom: "100%", marginBottom: 2, transform: `scale(${1 / Math.max(zoomLevel, 0.6)})`, transformOrigin: "bottom left" }}
                      >
                        Fila {viewingImage.fila}{viewingImage.totalPages > 1 ? ` · Pág ${viewingImage.pagina}` : ""}{bboxNudge !== 0 ? ` (${bboxNudge > 0 ? "+" : ""}${bboxNudge})` : ""}
                      </span>
                    )}
                  </motion.div>
                  );
                })()}
              </div>
            </div>

            {/* Panel de edición del registro actual */}
            {viewingRow && (
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute z-40 pointer-events-auto bg-slate-900/92 backdrop-blur-2xl text-white shadow-2xl flex flex-col
                  inset-x-0 bottom-0 max-h-[46vh] rounded-t-3xl border-t border-white/10
                  md:inset-y-0 md:left-auto md:right-0 md:bottom-auto md:w-[384px] md:max-h-none md:rounded-none md:border-t-0 md:border-l md:pt-20"
              >
                {/* `flex-1 min-h-0` es lo que hace que este bloque scrollee de verdad.
                    Un ítem flex tiene min-height:auto por defecto, así que crecía hasta
                    la altura de su contenido y desbordaba el panel en vez de recortarse:
                    overflow-y-auto no tenía nada que recortar y la lista de búsqueda
                    quedaba cortada por abajo, sin forma de llegar a ella. */}
                <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4 scrollbar-hide">
                  <div className="md:hidden mx-auto w-10 h-1 rounded-full bg-white/20 -mt-1 mb-1" />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <UserCheck size={16} className="text-blue-400" />
                      <span className="text-sm font-bold">Editar registro</span>
                    </div>
                    <span className="text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-400/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                      Fila {viewingRow.filaDoc || "?"}{viewingImage.totalPages > 1 ? ` · Pág ${viewingImage.pagina}` : ""}
                    </span>
                  </div>

                  {/* Desplegable: navegar solo entre registros FUERA (sin match) */}
                  {(() => {
                    const fueraRows = datosDelProyecto.filter((r) => !getMasterInfo(r.dni));
                    return (
                      <div>
                        <div className="flex items-stretch gap-1.5">
                          <button
                            onClick={() => setViewerDropdownOpen((o) => !o)}
                            className="flex-1 min-w-0 flex items-center justify-between gap-2 bg-red-500/10 hover:bg-red-500/15 border border-red-400/30 rounded-xl px-3 py-2 text-left transition-colors"
                          >
                            <div className="min-w-0">
                              <p className="text-[9px] text-red-300 font-bold uppercase tracking-wider">Sin match (FUERA): {fueraRows.length}</p>
                              <p className="text-xs font-semibold text-white truncate">
                                {viewingRowMaster ? "Este registro ya tiene match ✓" : `Fila ${viewingRow.filaDoc || "?"} · ${viewingRow.nombre || "—"}`}
                              </p>
                            </div>
                            <ChevronDown size={16} className={`text-white/60 shrink-0 transition-transform ${viewerDropdownOpen ? "rotate-180" : ""}`} />
                          </button>

                          {/* Recorrer la cola de revisión sin abrir el desplegable */}
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => goToQueue(-1)}
                              disabled={viewerQueueIdx <= 0}
                              title="Registro anterior"
                              className="h-full px-2 rounded-xl border border-white/15 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5 transition-colors"
                            >
                              <ChevronLeft size={18} />
                            </button>
                            <button
                              onClick={() => goToQueue(1)}
                              disabled={viewerQueueIdx < 0 || viewerQueueIdx >= viewerQueue.length - 1}
                              title="Registro siguiente"
                              className="h-full px-2 rounded-xl border border-white/15 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5 transition-colors"
                            >
                              <ChevronRight size={18} />
                            </button>
                          </div>
                        </div>
                        {viewerQueueIdx >= 0 && viewerQueue.length > 1 && (
                          <p className="text-[9px] text-white/35 font-bold text-center mt-1 tabular-nums">
                            {viewerQueueIdx + 1} de {viewerQueue.length} por revisar
                          </p>
                        )}
                        {viewerDropdownOpen && (
                          <div className="mt-1 bg-slate-800/95 border border-white/10 rounded-xl max-h-64 overflow-y-auto scrollbar-hide divide-y divide-white/5">
                            {fueraRows.length === 0 && <p className="text-xs text-white/40 py-4 text-center">No hay registros FUERA 🎉</p>}
                            {fueraRows.map((r) => (
                              <button
                                key={r.id}
                                onClick={() => { handleViewRow(r); setViewerDropdownOpen(false); }}
                                className={`w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-2 transition-colors ${r.id === viewingRow.id ? "bg-red-500/15" : ""}`}
                              >
                                <span className="text-[10px] font-mono font-bold text-red-300 bg-red-500/15 px-1.5 py-0.5 rounded shrink-0">F{r.filaDoc || "?"}</span>
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-semibold text-white truncate">{r.nombre || "—"}</p>
                                  <p className="text-[10px] text-white/40 font-mono truncate">{r.dni || "sin DNI"} · {r.sourceFile}</p>
                                </div>
                                {r.id === viewingRow.id && <Check size={14} className="text-red-300 shrink-0" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div>
                    <p className="text-[10px] text-white/40 font-bold uppercase tracking-wider mb-1">Apellidos y Nombres (Extraído)</p>
                    <p className="text-sm font-semibold text-white leading-snug bg-white/5 border border-white/10 rounded-xl px-3 py-2 break-words">{viewingRow.nombre || "—"}</p>
                  </div>

                  <div>
                    <p className="text-[10px] text-white/40 font-bold uppercase tracking-wider mb-1">DNI</p>
                    <div className="flex items-center gap-2">
                      <input
                        value={viewingRow.dni}
                        onChange={(e) => applyDniToRow(viewingRow.id, e.target.value, "MANUAL")}
                        className={`flex-1 px-3 py-2 rounded-xl border outline-none font-mono text-sm transition-all ${viewingRowMaster ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-200" : "bg-red-500/15 border-red-400/40 text-red-200"}`}
                      />
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-lg whitespace-nowrap ${viewingRowMaster ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>{viewingRowMaster ? "OK" : "FUERA"}</span>
                    </div>
                  </div>

                  {viewingRowMaster && (
                    <div className="bg-emerald-500/10 border border-emerald-400/20 rounded-xl p-3">
                      <p className="text-[10px] text-emerald-300 font-bold uppercase tracking-wider mb-1 flex items-center gap-1"><Database size={10} /> Dato Maestro</p>
                      <p className="text-sm font-semibold text-white">{viewingRowMaster.nombre}</p>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded font-mono text-white/70">{viewingRowMaster.dni}</span>
                        {viewingRowMaster.cargo && <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded text-white/70">{viewingRowMaster.cargo}</span>}
                        {viewingRowMaster.area && <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded text-white/70">{viewingRowMaster.area}</span>}
                      </div>
                    </div>
                  )}

                  {!viewingRowMaster && viewingRow.matchCandidates && viewingRow.matchCandidates.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-[10px] text-amber-300 font-bold uppercase tracking-wider">💡 Sugerencias</p>
                      {viewingRow.matchCandidates.map((c, ci) => (
                        <button key={ci} onClick={() => applyDniToRow(viewingRow.id, c.master.dni, "AUTO", c.score)} className="text-left bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/20 rounded-xl px-3 py-2 transition-colors">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-white truncate">{c.master.nombre}</span>
                            <span className="text-[10px] font-bold text-amber-300 shrink-0">{Math.round(c.score * 100)}%</span>
                          </div>
                          <span className="text-[10px] text-white/50 font-mono">{c.master.dni}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="border-t border-white/10 pt-4">
                    <p className="text-[10px] text-white/40 font-bold uppercase tracking-wider mb-2 flex items-center gap-1"><Search size={11} /> Buscar en lista maestra</p>
                    <div className="flex items-center gap-2 bg-white/10 border border-white/15 rounded-xl px-3 py-2 mb-2">
                      <Search size={14} className="text-white/40 shrink-0" />
                      <input value={viewerQuery} onChange={(e) => setViewerQuery(e.target.value)} placeholder="Nombre, apellido o DNI..." className="flex-1 bg-transparent text-white text-sm placeholder-white/40 outline-none" />
                      {viewerQuery && <button onClick={() => setViewerQuery("")} className="text-white/40 hover:text-white"><X size={14} /></button>}
                    </div>
                    <div className="flex flex-col gap-1 max-h-52 md:max-h-none overflow-y-auto scrollbar-hide">
                      {viewerQuery.trim() && viewerResults.length === 0 && (
                        <p className="text-xs text-white/40 py-3 text-center">Sin resultados para "{viewerQuery}"</p>
                      )}
                      {viewerResults.map(({ master: m, score }, i) => {
                        const isCurrent = normalizeDniStrict(m.dni) === normalizeDniStrict(viewingRow.dni) && !!normalizeDniStrict(m.dni);
                        return (
                          <button key={i} onClick={() => applyDniToRow(viewingRow.id, m.dni, "MANUAL")} className={`text-left rounded-xl px-3 py-2 border transition-colors ${isCurrent ? "bg-emerald-500/15 border-emerald-400/40" : "bg-white/5 hover:bg-white/10 border-white/10"}`}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-white truncate">{highlightSearchMatch(m.nombre, viewerQuery)}</span>
                              {isCurrent ? <Check size={14} className="text-emerald-400 shrink-0" /> : <span className="text-[9px] text-white/40 shrink-0">{score >= 1.5 ? '●●●' : score >= 0.8 ? '●●○' : '●○○'}</span>}
                            </div>
                            <span className="text-[10px] text-white/60 font-mono">{highlightSearchMatch(m.dni, normalizeDniStrict(viewerQuery).length >= 2 ? viewerQuery : '')}</span>
                            {(m.cargo || m.area) && <span className="text-[9px] text-white/40 block truncate">{[m.cargo, m.area].filter(Boolean).join(' · ')}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Hint Overlay */}
            {!viewingRow && (
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 hidden md:flex items-center gap-6 px-8 py-4 bg-black/40 backdrop-blur-2xl rounded-3xl border border-white/10 shadow-2xl pointer-events-none opacity-60">
              <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest"><MousePointer2 size={14} className="text-blue-400" /> Rueda: Zoom</div>
              <div className="h-4 w-[1px] bg-white/10" />
              <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest"><Grab size={14} className="text-blue-400" /> Click: Arrastrar</div>
              <div className="h-4 w-[1px] bg-white/10" />
              <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest"><Maximize2 size={14} className="text-blue-400" /> Doble Click: Reset</div>
            </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Search (FAB) */}
      <div className="fixed bottom-8 right-8 z-50 flex flex-col items-end gap-3">
        <AnimatePresence>
          {showSearch && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
              style={{ width: 360, maxHeight: 520 }}
            >
              {/* Header / Input */}
              <div className="p-3 bg-gradient-to-r from-blue-600 to-indigo-600">
                <div className="flex items-center gap-2 bg-white/15 border border-white/25 rounded-xl px-3 py-2">
                  <Search size={14} className="text-white/70 shrink-0" />
                  <input
                    autoFocus
                    placeholder="Buscar por nombre, apellido o DNI..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="flex-1 bg-transparent text-white text-sm placeholder-white/60 outline-none"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery("")} className="text-white/60 hover:text-white transition-colors">
                      <X size={14} />
                    </button>
                  )}
                </div>
                {searchQuery.trim() && (
                  <p className="text-white/60 text-[10px] mt-2 px-1">
                    {searchResults.length} resultado{searchResults.length !== 1 ? "s" : ""} · click para copiar DNI
                  </p>
                )}
              </div>

              {/* Results */}
              <div className="overflow-y-auto flex-1">
                {!searchQuery.trim() && (
                  <div className="flex flex-col items-center justify-center py-10 text-slate-400 gap-2">
                    <Search size={28} className="opacity-30" />
                    <p className="text-xs font-medium">Escribe para buscar en la lista maestra</p>
                    <p className="text-[10px] opacity-70">Nombre, apellido o DNI</p>
                  </div>
                )}
                {searchQuery.trim() && searchResults.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-10 text-slate-400 gap-2">
                    <AlertCircle size={24} className="opacity-40" />
                    <p className="text-xs font-medium">Sin resultados para "{searchQuery}"</p>
                    <p className="text-[10px] opacity-70">Prueba con otro nombre o parte del DNI</p>
                  </div>
                )}
                {searchResults.map(({ master: m, score, matchType }, i) => (
                  <button
                    key={i}
                    onClick={async () => {
                      // Mismo motivo que en el botón Copiar: fuera de contexto seguro
                      // navigator.clipboard no existe y esto reventaba en silencio.
                      const ok = await copiarTexto(m.dni);
                      if (!ok) { mostrarToast("error", "No se pudo copiar el DNI."); return; }
                      setCopiedDni(m.dni);
                      setTimeout(() => setCopiedDni(null), 1500);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-blue-50 transition-colors border-b border-slate-50 last:border-0 group/item"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-slate-800 uppercase leading-snug truncate">
                          {highlightSearchMatch(m.nombre, searchQuery)}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className={`font-mono text-[11px] font-bold ${matchType === 'dni_exact' || matchType === 'dni_partial' ? 'text-blue-600' : 'text-slate-500'}`}>
                            {highlightSearchMatch(m.dni, normalizeDniStrict(searchQuery).length >= 3 ? searchQuery : '')}
                          </span>
                          {(matchType === 'dni_exact' || matchType === 'dni_partial') && (
                            <span className="text-[8px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide">DNI</span>
                          )}
                          {matchType === 'fuzzy' && (
                            <span className="text-[8px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide">~aprox</span>
                          )}
                        </div>
                        {(m.cargo || m.area) && (
                          <div className="flex gap-1.5 mt-1 flex-wrap">
                            {m.cargo && <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded truncate max-w-[160px]">{m.cargo}</span>}
                            {m.area && <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded truncate max-w-[120px]">{m.area}</span>}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        {copiedDni === m.dni ? (
                          <span className="text-[9px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold">¡Copiado!</span>
                        ) : (
                          <span className="text-[9px] text-slate-300 group-hover/item:text-slate-500 transition-colors font-medium opacity-0 group-hover/item:opacity-100">Copiar</span>
                        )}
                        <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${score >= 1.5 ? 'bg-emerald-100 text-emerald-700' : score >= 0.8 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`}>
                          {score >= 1.5 ? '●●●' : score >= 0.8 ? '●●○' : '●○○'}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex items-center gap-3 justify-end">
          {showSearch && searchQuery.trim() && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[10px] text-slate-500 bg-white px-2 py-1 rounded-lg shadow border border-slate-200">
              {searchResults.length} resultado{searchResults.length !== 1 ? "s" : ""}
            </motion.span>
          )}
          <button
            onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery(""); }}
            className={`p-4 rounded-full shadow-2xl transition-all active:scale-95 ${showSearch ? "bg-slate-800 hover:bg-slate-700" : "bg-blue-600 hover:bg-blue-700"} text-white`}
          >
            {showSearch ? <X size={24}/> : <SearchCode size={24}/>}
          </button>
        </div>
      </div>

      {/* Aviso propio. Sustituye a alert(), que en móvil se suprime a menudo y dejaba
          acciones completándose (o fallando) sin que el usuario viera nada. */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw]"
          >
            <div
              role="status"
              className={`flex items-start gap-2.5 px-4 py-3 rounded-xl shadow-2xl text-xs md:text-sm font-medium text-white ${toast.tipo === "ok" ? "bg-emerald-600" : "bg-red-600"}`}
            >
              {toast.tipo === "ok" ? <CheckCircle2 size={16} className="flex-shrink-0 mt-px" /> : <AlertCircle size={16} className="flex-shrink-0 mt-px" />}
              <span>{toast.msg}</span>
              <button onClick={() => setToast(null)} className="ml-1 opacity-70 hover:opacity-100 flex-shrink-0"><X size={14} /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* IdRef dentro de la app: prompt() es un diálogo nativo y puede no aparecer nunca,
          en cuyo caso el envío a Sheets moría en silencio. */}
      <AnimatePresence>
        {sheetsModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/50 p-4"
            onClick={() => setSheetsModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5"
            >
              <div className="flex items-center gap-2 mb-1">
                <Database size={18} className="text-green-600" />
                <h3 className="font-bold text-slate-800">Enviar a Google Sheets</h3>
              </div>
              {/* El envío es irreversible desde aquí: si se manda el proyecto que no era,
                  hay que ir a limpiarlo a mano en la hoja. Por eso el origen se nombra
                  antes de confirmar, y no solo con el resaltado del lateral. */}
              <p className="text-xs text-slate-500 mb-4">
                Se enviarán <strong className="text-slate-700">{displayedData.filter((r: ExtractedRow) => !!getMasterInfo(r.dni)).length} participante(s)</strong> con coincidencia en la maestra
                {proyectoActivo
                  ? <> del documento <strong className="text-slate-700">{proyectoActivo.name}</strong>{projectTitles[proyectoActivo.id]?.trim() ? ` («${projectTitles[proyectoActivo.id].trim()}»)` : ""}.</>
                  : files.length > 1
                    ? <> de <strong className="text-slate-700">los {files.length} documentos cargados</strong>. Selecciona uno en el lateral si solo quieres enviar ese.</>
                    : <>.</>}
              </p>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">IdRef</label>
              <input
                autoFocus
                value={idRefInput}
                onChange={(e) => setIdRefInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSendToSheets(idRefInput); if (e.key === "Escape") setSheetsModal(false); }}
                placeholder="Ej. IND-2026-014"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-green-500 transition-colors"
              />
              <div className="flex gap-2 mt-4">
                <button onClick={() => setSheetsModal(false)} className="flex-1 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">
                  Cancelar
                </button>
                <button
                  onClick={() => handleSendToSheets(idRefInput)}
                  disabled={!idRefInput.trim() || sending}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
                >
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />} Enviar
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmación del envío. A diferencia del resto de avisos, este no se cierra solo
          ni al pulsar fuera: hay que aceptarlo. Es el acuse de recibo de una acción que
          ya no se puede deshacer desde aquí, así que tiene que quedar leído. */}
      <AnimatePresence>
        {envioOk && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="envio-ok-titulo"
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.94, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center"
            >
              <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center">
                <CheckCircle2 size={30} className="text-emerald-600" />
              </div>
              <h3 id="envio-ok-titulo" className="text-lg font-bold text-slate-800 mb-1">Envío exitoso</h3>
              <p className="text-sm text-slate-500 leading-relaxed">
                Se enviaron <strong className="text-slate-700">{envioOk.cantidad} participante(s)</strong> a Google Sheets.
              </p>
              <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-left">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Proyecto</p>
                <p className="text-xs font-semibold text-slate-700 truncate">{envioOk.proyecto}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-2">IdRef</p>
                <p className="text-xs font-mono font-semibold text-slate-700 truncate">{envioOk.idRef}</p>
              </div>
              <button
                autoFocus
                onClick={() => setEnvioOk(null)}
                className="w-full mt-5 px-3 py-2.5 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors"
              >
                Aceptar
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function HeaderCell({ label, colKey, sortConfig, onSort, onFilter, isFiltered, center, width, onResizeStart }: any) {
  return (
    <th className={`px-6 py-4 border-b border-slate-200 relative group group/th ${center ? "text-center" : ""}`} style={{ width, minWidth: 50 }}>
      <div className={`flex items-center gap-1.5 ${center ? "justify-center" : ""}`}>
        <span className="cursor-pointer select-none" onClick={() => onSort(colKey)}>{label}</span>
        <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={(e) => { e.stopPropagation(); onSort(colKey); }} className={`${sortConfig?.key === colKey ? "text-blue-600" : "text-slate-300"} hover:text-blue-400`}>{sortConfig?.key === colKey ? (sortConfig.direction === 'asc' ? <ArrowUp size={10}/> : <ArrowDown size={10}/>) : <ArrowUpDown size={10}/>}</button>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onFilter(); }} className={`p-1 rounded hover:bg-slate-100 transition-colors ${isFiltered ? "text-blue-600" : "text-slate-300"}`}><Filter size={10} fill={isFiltered ? "currentColor" : "none"} /></button>
      </div>
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400 opacity-0 group-hover/th:opacity-100 transition-opacity z-10"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResizeStart(colKey, e.clientX, width); }}
      />
    </th>
  );
}
