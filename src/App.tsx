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
  ArrowUpDown, ArrowUp, ArrowDown, Filter, ChevronDown, Check, Image as ImageIcon,
  Maximize2, RotateCcw, MousePointer2, Grab, Menu
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { processDocuments } from "./lib/gemini";
import { renderPdfToImages } from "./lib/pdf";
import { detectDataRowBands } from "./lib/rowDetect";
import { APP_NAME, APP_SUBTITLE, MASTER_DATA_URL } from "./config";
import { normalizeDniStrict, nameMatchScore, dniFuzzyScore, confidenceLevel, normalizeText } from "./lib/matching";

interface DocumentFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  previewUrl: string | null;
  base64: string;
  pages: string[]; // imágenes (data URL) por página; imagen = 1 página
}

interface BBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

type MatchMethod = "DEFAULT" | "MANUAL" | "IA";

interface ExtractedRow {
  id: string;
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
    // Enviar datos a Google Sheets
    const handleSendToSheets = async () => {
      const IdRef = prompt("Ingrese el IdRef para enviar los datos:");
      if (!IdRef) {
        alert("Debe ingresar un IdRef para continuar.");
        return;
      }
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
          alert("No hay participantes con coincidencias válidas para enviar.");
          setSending(false);
          return;
        }
        const response = await fetch(GOOGLE_SHEETS_WEBAPP_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ IdRef, participantes })
        });
        const result = await response.json();
        if (result.success) {
          alert("¡Datos enviados correctamente a Google Sheets!");
        } else {
          alert("Error al enviar: " + result.message);
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          alert("Error de red o servidor: " + err.message);
        } else {
          alert("Error de red o servidor desconocido");
        }
      }
      setSending(false);
    };
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [status, setStatus] = useState<"idle" | "processing" | "success" | "error">("idle");
  const [extractedData, setExtractedData] = useState<ExtractedRow[]>([]);
  const [masterData, setMasterData] = useState<MasterRow[]>([]);
  const [modelUsed, setModelUsed] = useState<string>("");
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

  const [tableFilter, setTableFilter] = useState("");
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [activeFilters, setActiveFilters] = useState<{ [key: string]: string[] }>({});
  const [openFilterMenu, setOpenFilterMenu] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);
  const [activeCandidateRow, setActiveCandidateRow] = useState<number | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    nro: 60, ver: 60, nombre: 200, dni: 130, estado: 80, method: 110, sourceFile: 130, filaDoc: 90, dniSheets: 130, nombreOficial: 220
  });
  const resizingRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const fetchMaster = async () => {
      try {
        const response = await fetch(MASTER_DATA_URL);
        const text = await response.text();
        const rows = text.split("\n").filter(r => r.trim());
        const parsed: MasterRow[] = rows.slice(1).map(row => {
          const cols = parseCSVRow(row);
          return {
            dni: cols[0] || "",
            nombre: cols[5] || "",
            cargo: cols[8] || "",
            area: cols[9] || ""
          };
        }).filter(r => r.dni);
        setMasterData(parsed);
      } catch (err) {
        console.error("Failed to load master list:", err);
      }
    };
    fetchMaster();
  }, []);

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

  const handleResizeStart = (col: string, clientX: number, currentWidth: number) => {
    resizingRef.current = { col, startX: clientX, startWidth: currentWidth };
  };

  const getMasterInfo = (dni: string) => {
    const normalized = normalizeDniStrict(dni);
    if (!normalized) return undefined;
    return masterData.find((m: MasterRow) => normalizeDniStrict(m.dni) === normalized);
  };

  const handleFilesAdded = async (newFiles: FileList | null) => {
    if (!newFiles || newFiles.length === 0) return;
    const validFiles = Array.from(newFiles).filter((f: File) => f.type.startsWith("image/") || f.type === "application/pdf");
    const newProcessedFiles: DocumentFile[] = [];
    for (const f of validFiles) {
      try {
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        let pages: string[] = [];
        let previewUrl: string | null = null;

        if (f.type.startsWith("image/")) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(f);
          });
          pages = [dataUrl];
          previewUrl = dataUrl;
        } else if (f.type === "application/pdf") {
          try {
            pages = await renderPdfToImages(base64Data);
            previewUrl = pages[0] || null;
          } catch (err) {
            console.error("No se pudo renderizar el PDF:", f.name, err);
          }
        }

        newProcessedFiles.push({
          id: Math.random().toString(36).substring(7),
          name: f.name, size: f.size, mimeType: f.type, base64: base64Data, previewUrl, pages
        });
      } catch (err) { console.error("Error processing file:", f.name, err); }
    }
    if (newProcessedFiles.length > 0) {
      setFiles((prev: DocumentFile[]) => [...prev, ...newProcessedFiles]);
      setStatus("idle");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const executeExtraction = async () => {
    if (files.length === 0) return;
    setStatus("processing");
    setErrorMessage("");
    setExtractedData([]);
    try {
      const inputFormats = files.map((f) => ({ data: f.base64, mimeType: f.mimeType, name: f.name }));
      const result = await processDocuments(inputFormats);
      const rows = result.csv.split('\n').slice(1);

      // Paso 1: parseo crudo (guardando la geometría de tabla y total de filas reportados).
      type RawRow = ExtractedRow & { _tableBox: BBox | null; _totalFilas: number };
      const rawRows: RawRow[] = rows.map((row: string, rowIndex: number) => {
        const cols = row.split(';');
        return {
          id: `r${rowIndex}_${Date.now()}`,
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
      setExtractedData(parsed);
      setModelUsed(result.modelUsed);
      setStatus("success");
    } catch (err: any) {
      console.error("Extraction failed:", err);
      setStatus("error");
      setErrorMessage(err.message || "Error en el procesamiento.");
    }
  };

  // Matching multicapa: Pasada 1 → DNI fuzzy, Pasada 2 → Nombre compuesto
  const tryFuzzyMatch = () => {
    const updated = [...extractedData];
    let matchesFound = 0;
    let suggestionsFound = 0;

    // Pasada 1: DNI fuzzy (1 dígito OCR erróneo tolerado)
    updated.forEach((row: ExtractedRow, idx: number) => {
      if (getMasterInfo(row.dni)) return;
      if (!row.dni || row.dni.length < 6) return;
      let bestMatch: MasterRow | null = null;
      let bestScore = 0;
      masterData.forEach((m: MasterRow) => {
        const score = dniFuzzyScore(row.dni, m.dni);
        if (score > bestScore) { bestScore = score; bestMatch = m; }
      });
      if (bestMatch && bestScore >= 0.875) {
        updated[idx] = { ...updated[idx], dni: bestMatch.dni, method: "IA" as MatchMethod, matchConfidence: bestScore, matchCandidates: undefined };
        matchesFound++;
      }
    });

    // Pasada 2: Nombre compuesto (Jaro-Winkler + token-set, agnóstico al orden)
    updated.forEach((row: ExtractedRow, idx: number) => {
      if (getMasterInfo(row.dni)) return;
      if (!row.nombre || row.nombre.length < 4) return;

      const candidates: { master: MasterRow; score: number }[] = [];
      masterData.forEach((m: MasterRow) => {
        const score = nameMatchScore(row.nombre, m.nombre);
        if (score >= 0.60) candidates.push({ master: m, score });
      });
      candidates.sort((a, b) => b.score - a.score);
      const top3 = candidates.slice(0, 3);

      if (top3.length === 0) return;

      const best = top3[0];
      if (best.score >= 0.78) {
        updated[idx] = { ...updated[idx], dni: best.master.dni, method: "IA" as MatchMethod, matchConfidence: best.score, matchCandidates: top3 };
        matchesFound++;
      } else {
        updated[idx] = { ...updated[idx], matchCandidates: top3 };
        suggestionsFound++;
      }
    });

    setExtractedData(updated);
    if (matchesFound > 0 || suggestionsFound > 0) {
      const parts = [];
      if (matchesFound > 0) parts.push(`${matchesFound} coincidencias aplicadas`);
      if (suggestionsFound > 0) parts.push(`${suggestionsFound} sugerencias para revisar`);
      alert(parts.join(" · ") + ".");
    } else {
      alert("No se encontraron nuevas coincidencias.");
    }
  };

  const acceptAllHighConfidence = () => {
    const updated = extractedData.map((row: ExtractedRow) => {
      if (row.method === "IA" && row.matchConfidence != null && row.matchConfidence >= 0.92 && !getMasterInfo(row.dni)) {
        return { ...row, method: "MANUAL" as MatchMethod };
      }
      return row;
    });
    setExtractedData(updated);
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

  const findSourceFile = (filename: string): DocumentFile | undefined => {
    if (!filename) return undefined;
    const base = filename.toLowerCase().split('.')[0];
    return files.find((f: DocumentFile) => f.name.toLowerCase().includes(base)) || files.find((f: DocumentFile) => f.name.toLowerCase() === filename.toLowerCase());
  };

  const openViewer = (filename: string, pagina: string, bbox: BBox | null, fila: string, rowId: string | null) => {
    const file = findSourceFile(filename);
    if (!file || !file.pages || file.pages.length === 0) {
      if (file && file.previewUrl) {
        setViewingImage({ url: file.previewUrl, name: file.name, bbox: null, fila: "", pagina: "1", totalPages: 1, rowId });
        setZoomLevel(1); setPanOffset({ x: 0, y: 0 }); setBboxNudge(0);
      }
      return;
    }
    const pageIdx = Math.max(0, (parseInt(pagina || "1", 10) || 1) - 1);
    const safeIdx = Math.min(pageIdx, file.pages.length - 1);
    setViewingImage({ url: file.pages[safeIdx], name: file.name, bbox, fila, pagina: String(safeIdx + 1), totalPages: file.pages.length, rowId });
    setZoomLevel(1); setPanOffset({ x: 0, y: 0 }); setBboxNudge(0);
  };

  // Abre el documento marcando la fila exacta del registro, con panel de edición.
  // Primero muestra la marca aproximada (IA) y luego la refina detectando el grid real.
  const handleViewRow = async (row: ExtractedRow) => {
    setViewerQuery(row.nombre || row.dni || "");
    openViewer(row.sourceFile, row.pagina, row.bbox, row.filaDoc, row.id);

    const fila = parseInt(row.filaDoc, 10);
    if (isNaN(fila) || fila < 1) return;
    const file = findSourceFile(row.sourceFile);
    if (!file || !file.pages?.length) return;
    const pageIdx = Math.min(Math.max(0, (parseInt(row.pagina || "1", 10) || 1) - 1), file.pages.length - 1);

    const xMin = row.bbox ? row.bbox.xmin / 1000 : 0.03;
    const xMax = row.bbox ? row.bbox.xmax / 1000 : 0.97;
    const bands = await detectDataRowBands(file.pages[pageIdx], xMin, xMax, row.rowTotal);
    if (!bands || !bands.length) return;

    // Alineado desde abajo: si el grid detectado incluye la fila de títulos al inicio,
    // se descarta. Las N filas de datos se anclan al final del grid.
    const N = row.rowTotal;
    let idx = (N >= 2 && bands.length >= N) ? bands.length - N + (fila - 1) : fila - 1;
    idx = Math.min(Math.max(0, idx), bands.length - 1);
    const band = bands[idx];
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

  // Advanced Viewer Handlers
  const handlePanStart = (e: React.MouseEvent) => {
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  };
  const handlePanMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    setPanOffset({ x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y });
  }, [isPanning]);
  const handlePanEnd = () => setIsPanning(false);

  // Touch Gestures State
  const touchStartDistRef = useRef<number | null>(null);
  const touchStartZoomRef = useRef<number>(1);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsPanning(true);
      panStartRef.current = { x: e.touches[0].clientX - panOffset.x, y: e.touches[0].clientY - panOffset.y };
      touchStartDistRef.current = null;
    } else if (e.touches.length === 2) {
      setIsPanning(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartDistRef.current = Math.hypot(dx, dy);
      touchStartZoomRef.current = zoomLevel;
    }
  };
  
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1 && isPanning) {
      setPanOffset({ x: e.touches[0].clientX - panStartRef.current.x, y: e.touches[0].clientY - panStartRef.current.y });
    } else if (e.touches.length === 2 && touchStartDistRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.hypot(dx, dy);
      const scale = currentDist / touchStartDistRef.current;
      setZoomLevel(Math.min(Math.max(touchStartZoomRef.current * scale, 0.5), 15));
    }
  }, [isPanning, zoomLevel]);

  const handleTouchEnd = () => {
    setIsPanning(false);
    touchStartDistRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey || true) { // Always allow wheel zoom for better UX
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = 1.1;
      setZoomLevel(prev => {
        const next = delta > 0 ? prev * factor : prev / factor;
        return Math.min(Math.max(next, 0.5), 15);
      });
    }
  };

  const resetViewer = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const displayedData = useMemo(() => {
    let result = [...extractedData];
    
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
  }, [extractedData, tableFilter, sortConfig, activeFilters, showOnlyErrors, masterData, editingRowId]);

  const toggleSort = (key: string) => setSortConfig((prev: { key: string, direction: 'asc' | 'desc' } | null) => (prev?.key === key && prev.direction === 'asc') ? { key, direction: 'desc' } : { key, direction: 'asc' });
  const toggleFilterValue = (column: string, value: string) => setActiveFilters((prev: { [key: string]: string[] }) => {
    const current = prev[column] || [];
    const updated = current.includes(value) ? current.filter((v: string) => v !== value) : [...current, value];
    return { ...prev, [column]: updated };
  });

  const getUniqueValues = (column: string): string[] => {
    if (column === "estado") return ["OK", "FUERA"];
    const values = extractedData.map((r: ExtractedRow) => r[column as keyof ExtractedRow] as string);
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

      <aside className={`fixed inset-y-0 left-0 z-50 transform ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 w-[300px] md:w-[360px] flex-shrink-0 bg-white border-r border-slate-200 flex flex-col items-stretch overflow-hidden shadow-2xl md:shadow-xl transition-transform duration-300 ease-in-out`}>
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
        </div>
        <div className="flex-1 overflow-y-auto p-6 scrollbar-hide">
          <div className="w-full border-2 border-dashed border-slate-300 rounded-2xl bg-slate-50/50 hover:bg-blue-50/50 hover:border-blue-400 transition-colors cursor-pointer group flex flex-col items-center justify-center p-8 mb-6" onClick={() => fileInputRef.current?.click()}>
            <div className="bg-white p-3 rounded-full shadow-sm text-slate-400 group-hover:text-blue-500 mb-3 transition-colors"><Upload size={24} /></div>
            <p className="text-sm font-medium text-slate-700 mb-1 text-center">Añadir documentos</p>
            <input type="file" multiple accept="image/*,application/pdf" className="hidden" ref={fileInputRef} onChange={(e) => handleFilesAdded(e.target.files)} />
          </div>
          <div className="space-y-3">
            {files.map((f) => (
              <div key={f.id} onDoubleClick={() => handleViewSource(f.name)} className="group relative flex items-center p-3 rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition-shadow cursor-pointer select-none">
                <div className="h-10 w-10 flex-shrink-0 bg-slate-100 rounded-lg flex items-center justify-center overflow-hidden border border-slate-200 text-slate-500">
                  {f.previewUrl ? <img src={f.previewUrl} alt="" className="object-cover w-full h-full" /> : <FileText size={20} />}
                </div>
                <div className="ml-3 flex-1 min-w-0 pr-8">
                  <p className="text-sm font-medium text-slate-800 truncate">{f.name}</p>
                </div>
                <button onClick={(e) => { e.stopPropagation(); setFiles(prev => prev.filter(x => x.id !== f.id)); }} className="absolute right-3 p-2 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"><X size={16} /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="p-6 border-t border-slate-200 bg-white">
          {isApiKeyMissing && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2 text-amber-700">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <p className="text-[10px] font-medium leading-tight">Configura VITE_GEMINI_API_KEY en Vercel</p>
            </div>
          )}
          <button disabled={files.length === 0 || status === "processing" || isApiKeyMissing} onClick={executeExtraction} className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white shadow-sm font-semibold rounded-xl py-3.5 transition-all text-sm">
            {status === "processing" ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />} Iniciar Extracción
          </button>
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

        <header className="flex-shrink-0 bg-white border-b border-slate-200 px-4 md:px-8 py-4 flex flex-col lg:flex-row items-start lg:items-center justify-between shadow-sm z-10 gap-4">
          <div className="flex items-center gap-4 w-full lg:w-auto justify-between">
            <h2 className="text-lg font-semibold text-slate-800 hidden md:flex items-center gap-3">
              Panel de Resultados
              {extractedData.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">Total: {extractedData.length}</span>
                  {extractedData.filter(r => !getMasterInfo(r.dni)).length > 0 && (
                    <button
                      onClick={() => setShowOnlyErrors(!showOnlyErrors)}
                      className={`text-xs font-bold px-2.5 py-1 rounded-full border transition-colors ${showOnlyErrors ? 'bg-red-600 text-white border-red-700' : 'bg-red-100 text-red-600 border-red-200 hover:bg-red-200'}`}
                    >
                      ⚠️ Sin Match: {extractedData.filter(r => !getMasterInfo(r.dni)).length}
                    </button>
                  )}
                  {extractedData.filter(r => !getMasterInfo(r.dni) && r.matchCandidates && r.matchCandidates.length > 0).length > 0 && (
                    <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full border border-amber-200">
                      💡 Sugerencias: {extractedData.filter(r => !getMasterInfo(r.dni) && r.matchCandidates && r.matchCandidates.length > 0).length}
                    </span>
                  )}
                </div>
              )}
            </h2>
            <div className="md:hidden flex items-center gap-2">
              <span className="font-semibold text-slate-700 text-sm">Resultados</span>
              {extractedData.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{extractedData.length}</span>
                  {extractedData.filter(r => !getMasterInfo(r.dni)).length > 0 && (
                    <button 
                      onClick={() => setShowOnlyErrors(!showOnlyErrors)}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-colors ${showOnlyErrors ? 'bg-red-600 text-white border-red-700' : 'bg-red-100 text-red-600 border-red-200'}`}
                    >
                      {extractedData.filter(r => !getMasterInfo(r.dni)).length} ⚠️
                    </button>
                  )}
                </div>
              )}
            </div>
            {extractedData.length > 0 && (
              <div className="flex items-center gap-2">
                <button onClick={tryFuzzyMatch} className="flex items-center gap-2 px-3 md:px-4 py-2 text-[10px] md:text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md active:scale-95 whitespace-nowrap">
                  <Sparkles size={14} /> <span className="hidden md:inline">Vincular por Nombre (IA)</span><span className="md:hidden">IA Link</span>
                </button>
                {extractedData.some(r => r.method === "IA" && r.matchConfidence != null && r.matchConfidence >= 0.92) && (
                  <button onClick={acceptAllHighConfidence} className="flex items-center gap-1.5 px-3 py-2 text-[10px] md:text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-full transition-all shadow-md active:scale-95 whitespace-nowrap">
                    <Check size={14} /> <span className="hidden md:inline">Aceptar Alta Confianza</span><span className="md:hidden">✓ AC</span>
                  </button>
                )}
              </div>
            )}
          </div>
          {extractedData.length > 0 && (
            <div className="flex items-center gap-2 md:gap-3 w-full lg:w-auto overflow-x-auto pb-2 lg:pb-0 scrollbar-hide">
              <div className="relative flex-shrink-0">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input placeholder="Filtro..." value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="pl-9 pr-4 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs outline-none focus:border-blue-400 focus:bg-white transition-all w-32 md:w-48" />
              </div>
              <button onClick={() => navigator.clipboard.writeText(getCsvString())} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs md:text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"><Copy size={14} /> <span className="hidden md:inline">Copiar</span></button>
              <button onClick={() => {
                const blob = new Blob([getCsvString()], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url; link.setAttribute("download", "participantes.csv"); link.click();
              }} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs md:text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 transition-colors"><Download size={14} /> <span className="hidden md:inline">Descargar</span></button>
              <button
                disabled={sending || displayedData.length === 0}
                onClick={handleSendToSheets}
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

          {extractedData.length > 0 && (
            <div className="w-full flex flex-col mb-20 md:mb-6">
              
              {/* VISTA MÓVIL: TARJETAS */}
              <div className="md:hidden flex flex-col gap-4">
                {displayedData.map((row, idx) => {
                  const master = getMasterInfo(row.dni);
                  const isValid = !!master;
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
                              onClick={() => setActiveCandidateRow(activeCandidateRow === idx ? null : idx)}
                              className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg hover:bg-amber-100 transition-colors"
                            >
                              💡 {row.matchCandidates.length} sugerencia{row.matchCandidates.length > 1 ? "s" : ""}
                            </button>
                            {activeCandidateRow === idx && (
                              <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-amber-200 rounded-xl shadow-lg p-2 min-w-[240px]">
                                {row.matchCandidates.map((c, ci) => (
                                  <button key={ci} onClick={() => {
                                    const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: c.master.dni, method: "IA" as MatchMethod, matchConfidence: c.score } : r);
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
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                            row.method === "IA"
                              ? row.matchConfidence != null && confidenceLevel(row.matchConfidence) === "high"
                                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                : row.matchConfidence != null && confidenceLevel(row.matchConfidence) === "medium"
                                  ? "bg-amber-100 text-amber-700 border-amber-200"
                                  : "bg-purple-100 text-purple-700 border-purple-200"
                              : row.method === "MANUAL" ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600 border-slate-200"
                          }`}>
                            {row.method === "IA" && row.matchConfidence != null
                              ? `IA ${Math.round(row.matchConfidence * 100)}%`
                              : row.method}
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
                      {displayedData.map((row, idx) => {
                        const master = getMasterInfo(row.dni);
                        const isValid = !!master;
                        return (
                          <tr key={row.id} className="hover:bg-slate-50/50 transition-colors group/row">
                            <td className="px-4 py-3 text-slate-400">{row.nro}</td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => handleViewRow(row)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"><Eye size={16} /></button>
                            </td>
                            <td className="px-6 py-3 truncate max-w-[180px] text-slate-800">{highlightMatch(row.nombre, tableFilter)}</td>
                            <td className="px-6 py-3">
                              <input type="text" value={row.dni} onChange={(e) => {
                                const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: e.target.value, method: "MANUAL" as MatchMethod } : r);
                                setExtractedData(updated);
                              }} onFocus={() => setEditingRowId(row.id)} onBlur={() => setEditingRowId(null)} className={`w-full px-2 py-1 rounded border outline-none transition-all font-mono text-sm ${isValid ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`} />
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
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold border ${
                                  row.method === "IA"
                                    ? row.matchConfidence != null && confidenceLevel(row.matchConfidence) === "high"
                                      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                      : row.matchConfidence != null && confidenceLevel(row.matchConfidence) === "medium"
                                        ? "bg-amber-100 text-amber-700 border-amber-200"
                                        : "bg-purple-100 text-purple-700 border-purple-200"
                                    : row.method === "MANUAL" ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600 border-slate-200"
                                }`}>
                                  {row.method === "IA" && row.matchConfidence != null
                                    ? `IA ${Math.round(row.matchConfidence * 100)}%`
                                    : row.method}
                                </span>
                                {!isValid && row.matchCandidates && row.matchCandidates.length > 0 && (
                                  <div className="relative">
                                    <button
                                      onClick={() => setActiveCandidateRow(activeCandidateRow === idx ? null : idx)}
                                      className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded hover:bg-amber-100 transition-colors"
                                    >
                                      💡 {row.matchCandidates.length}
                                    </button>
                                    {activeCandidateRow === idx && (
                                      <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-amber-200 rounded-xl shadow-lg p-2 min-w-[260px]">
                                        {row.matchCandidates.map((c, ci) => (
                                          <button key={ci} onClick={() => {
                                            const updated = extractedData.map(r => r.id === row.id ? { ...r, dni: c.master.dni, method: "IA" as MatchMethod, matchConfidence: c.score } : r);
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
                  <h3 className="text-lg font-bold text-slate-800 mb-2">Extrayendo Datos con IA</h3>
                  <p className="text-sm text-slate-500 leading-relaxed">Estamos analizando tus documentos. Esto puede tomar unos segundos dependiendo de la complejidad...</p>
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
                  <button onClick={() => setZoomLevel(p => Math.max(0.5, p/1.2))} className="p-1.5 md:p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg md:rounded-xl transition-all"><ZoomOut size={16} className="md:w-5 md:h-5"/></button>
                  <div className="px-2 md:px-4 min-w-[50px] md:min-w-[70px] text-center"><span className="text-xs md:text-sm font-mono font-black text-blue-400">{(zoomLevel*100).toFixed(0)}%</span></div>
                  <button onClick={() => setZoomLevel(p => Math.min(15, p*1.2))} className="p-1.5 md:p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg md:rounded-xl transition-all"><ZoomIn size={16} className="md:w-5 md:h-5"/></button>
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
              <motion.div
                animate={{ scale: zoomLevel, x: panOffset.x, y: panOffset.y }}
                transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.5 }}
                className="relative pointer-events-none"
                style={{ width: "fit-content", height: "fit-content", lineHeight: 0 }}
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
              </motion.div>
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
                <div className="overflow-y-auto p-5 flex flex-col gap-4 scrollbar-hide">
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
                    const fueraRows = extractedData.filter((r) => !getMasterInfo(r.dni));
                    return (
                      <div>
                        <button
                          onClick={() => setViewerDropdownOpen((o) => !o)}
                          className="w-full flex items-center justify-between gap-2 bg-red-500/10 hover:bg-red-500/15 border border-red-400/30 rounded-xl px-3 py-2 text-left transition-colors"
                        >
                          <div className="min-w-0">
                            <p className="text-[9px] text-red-300 font-bold uppercase tracking-wider">Sin match (FUERA): {fueraRows.length}</p>
                            <p className="text-xs font-semibold text-white truncate">
                              {viewingRowMaster ? "Este registro ya tiene match ✓" : `Fila ${viewingRow.filaDoc || "?"} · ${viewingRow.nombre || "—"}`}
                            </p>
                          </div>
                          <ChevronDown size={16} className={`text-white/60 shrink-0 transition-transform ${viewerDropdownOpen ? "rotate-180" : ""}`} />
                        </button>
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
                        <button key={ci} onClick={() => applyDniToRow(viewingRow.id, c.master.dni, "IA", c.score)} className="text-left bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/20 rounded-xl px-3 py-2 transition-colors">
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
                    onClick={() => {
                      navigator.clipboard.writeText(m.dni);
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
