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
  Maximize2, RotateCcw, MousePointer2, Grab
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { processDocuments } from "./lib/gemini";
import { APP_NAME, APP_SUBTITLE, MASTER_DATA_URL } from "./config";

interface DocumentFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  previewUrl: string | null;
  base64: string;
}

type MatchMethod = "DEFAULT" | "MANUAL" | "IA";

interface ExtractedRow {
  nro: string;
  nombre: string;
  dni: string;
  ocupacion: string;
  area: string;
  sourceFile: string;
  method: MatchMethod;
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

export default function App() {
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [status, setStatus] = useState<"idle" | "processing" | "success" | "error">("idle");
  const [extractedData, setExtractedData] = useState<ExtractedRow[]>([]);
  const [masterData, setMasterData] = useState<MasterRow[]>([]);
  const [modelUsed, setModelUsed] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isApiKeyMissing, setIsApiKeyMissing] = useState<boolean>(false);
  
  useEffect(() => {
    // Check for API key on mount
    const key = import.meta.env.VITE_GEMINI_API_KEY;
    if (!key) {
      setIsApiKeyMissing(true);
      setErrorMessage("ADVERTENCIA: Falta la variable de entorno VITE_GEMINI_API_KEY. Configúrala en Vercel para que la extracción funcione.");
    }
  }, []);
  
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  
  // Viewer state
  const [viewingImage, setViewingImage] = useState<{ url: string, name: string } | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  const [tableFilter, setTableFilter] = useState("");
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [activeFilters, setActiveFilters] = useState<{ [key: string]: string[] }>({});
  const [openFilterMenu, setOpenFilterMenu] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const normalizeDni = (dni: string) => dni.toString().replace(/^0+/, "").trim();
  const getMasterInfo = (dni: string) => {
    const normalized = normalizeDni(dni);
    return masterData.find(m => normalizeDni(m.dni) === normalized);
  };

  const handleFilesAdded = async (newFiles: FileList | null) => {
    if (!newFiles || newFiles.length === 0) return;
    const validFiles = Array.from(newFiles).filter(f => f.type.startsWith("image/") || f.type === "application/pdf");
    const newProcessedFiles: DocumentFile[] = [];
    for (const f of validFiles) {
      try {
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        const previewUrl = f.type.startsWith("image/") ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }) : null;
        newProcessedFiles.push({
          id: Math.random().toString(36).substring(7),
          name: f.name, size: f.size, mimeType: f.type, base64: base64Data, previewUrl: previewUrl
        });
      } catch (err) { console.error("Error processing file:", f.name, err); }
    }
    if (newProcessedFiles.length > 0) {
      setFiles(prev => [...prev, ...newProcessedFiles]);
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
      const parsed: ExtractedRow[] = rows.map(row => {
        const cols = row.split(';');
        return {
          nro: cols[0] || "", nombre: cols[1] || "", dni: cols[2] || "",
          ocupacion: cols[3] || "", area: cols[4] || "", sourceFile: cols[5]?.trim() || "",
          method: "DEFAULT"
        };
      }).filter(r => r.nombre || r.dni);
      setExtractedData(parsed);
      setModelUsed(result.modelUsed);
      setStatus("success");
    } catch (err: any) {
      console.error("Extraction failed:", err);
      setStatus("error");
      setErrorMessage(err.message || "Error en el procesamiento.");
    }
  };

  // Levenshtein distance para similitud de cadenas
  function levenshtein(a: string, b: string) {
    const an = a ? a.length : 0;
    const bn = b ? b.length : 0;
    if (an === 0) return bn;
    if (bn === 0) return an;
    const matrix = Array.from({ length: an + 1 }, () => Array(bn + 1).fill(0));
    for (let i = 0; i <= an; i++) matrix[i][0] = i;
    for (let j = 0; j <= bn; j++) matrix[0][j] = j;
    for (let i = 1; i <= an; i++) {
      for (let j = 1; j <= bn; j++) {
        const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[an][bn];
  }

  // Mejor reconocimiento de coincidencias por IA
  const tryFuzzyMatch = () => {
    const updated = [...extractedData];
    let matchesFound = 0;
    updated.forEach((row, idx) => {
      if (!getMasterInfo(row.dni)) {
        const query = row.nombre.toLowerCase().trim();
        if (query.length < 4) return;
        // Buscar mejor coincidencia por similitud de Levenshtein
        let bestMatch: MasterRow | null = null;
        let bestScore = Infinity;
        masterData.forEach(m => {
          const score = levenshtein(query, m.nombre.toLowerCase());
          if (score < bestScore) {
            bestScore = score;
            bestMatch = m;
          }
        });
        // Si la similitud es suficientemente alta (ajustar umbral según necesidad)
        if (bestMatch && bestScore <= Math.max(3, Math.floor(query.length * 0.25))) {
          updated[idx].dni = bestMatch.dni;
          updated[idx].method = "IA";
          matchesFound++;
        }
      }
    });
    if (matchesFound > 0) {
      setExtractedData(updated);
      alert(`Se encontraron ${matchesFound} coincidencias por nombre (IA mejorada).`);
    } else alert("No se encontraron nuevas coincidencias.");
  };

  const getCsvString = () => {
    const header = "DNI;NOMBRE OFICIAL;OCUPACION;AREA;METODO;ORIGEN";
    const bodyRows = displayedData.map(row => {
      const master = getMasterInfo(row.dni);
      if (!master) return null;
      return `${row.dni.toUpperCase()};${master.nombre.toUpperCase()};${master.cargo.toUpperCase()};${master.area.toUpperCase()};${row.method};${row.sourceFile}`;
    }).filter(r => r !== null);
    return [header, ...bodyRows].join('\n');
  };

  const handleViewSource = (filename: string) => {
    if (!filename) return;
    const file = files.find(f => f.name.toLowerCase().includes(filename.toLowerCase().split('.')[0]));
    if (file?.previewUrl) {
      setViewingImage({ url: file.previewUrl, name: file.name });
      setZoomLevel(1); setPanOffset({ x: 0, y: 0 });
    }
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
    if (tableFilter) {
      const q = tableFilter.toLowerCase();
      result = result.filter(r => r.nombre.toLowerCase().includes(q) || r.dni.toLowerCase().includes(q) || r.sourceFile.toLowerCase().includes(q));
    }
    Object.keys(activeFilters).forEach(key => {
      const selectedValues = activeFilters[key];
      if (selectedValues.length > 0) {
        result = result.filter(r => {
          if (key === "estado") {
            const master = getMasterInfo(r.dni);
            return selectedValues.includes(!!master ? "OK" : "FUERA");
          }
          return selectedValues.includes(r[key as keyof ExtractedRow] as string);
        });
      }
    });
    if (sortConfig) {
      result.sort((a, b) => {
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
  }, [extractedData, tableFilter, sortConfig, activeFilters]);

  const toggleSort = (key: string) => setSortConfig(prev => (prev?.key === key && prev.direction === 'asc') ? { key, direction: 'desc' } : { key, direction: 'asc' });
  const toggleFilterValue = (column: string, value: string) => setActiveFilters(prev => {
    const current = prev[column] || [];
    const updated = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    return { ...prev, [column]: updated };
  });

  const getUniqueValues = (column: string) => {
    if (column === "estado") return ["OK", "FUERA"];
    const values = extractedData.map(r => r[column as keyof ExtractedRow] as string);
    return Array.from(new Set(values)).filter(Boolean).sort();
  };

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase().trim();
    const normalizedQuery = normalizeDni(query);
    return masterData.filter(m => {
      const nameMatch = m.nombre.toLowerCase().includes(query);
      const dniMatch = normalizeDni(m.dni).includes(normalizedQuery);
      return nameMatch || dniMatch;
    }).slice(0, 10);
  }, [searchQuery, masterData]);

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-800 font-sans overflow-hidden relative">
      <aside className="w-[360px] flex-shrink-0 bg-white border-r border-slate-200 flex flex-col items-stretch overflow-hidden shadow-xl z-20">
        <div className="px-6 py-6 border-b border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-lg"><FileDigit size={24} /></div>
          <div>
            <h1 className="font-semibold text-lg leading-tight text-slate-900">{APP_NAME}</h1>
            <p className="text-xs text-slate-500 font-medium tracking-wide uppercase">{APP_SUBTITLE}</p>
          </div>
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

      <main className="flex-1 overflow-hidden flex flex-col bg-[#FAFAFA]">
        <header className="h-[73px] flex-shrink-0 bg-white border-b border-slate-200 px-8 flex items-center justify-between shadow-sm z-10">
          <div className="flex items-center gap-6">
            <h2 className="text-lg font-semibold text-slate-800">Panel de Resultados</h2>
            {extractedData.length > 0 && (
              <button onClick={tryFuzzyMatch} className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md active:scale-95">
                <Sparkles size={14} /> Vincular por Nombre (IA)
              </button>
            )}
          </div>
          {extractedData.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="relative mr-4">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input placeholder="Filtro rápido..." value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="pl-9 pr-4 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs outline-none focus:border-blue-400 focus:bg-white transition-all w-48" />
              </div>
              <button onClick={() => navigator.clipboard.writeText(getCsvString())} className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"><Copy size={16} /> Copiar</button>
              <button onClick={() => {
                const blob = new Blob([getCsvString()], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url; link.setAttribute("download", "participantes.csv"); link.click();
              }} className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 transition-colors"><Download size={16} /> Descargar</button>
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
            <div className="w-full bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col mb-20">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-600 border-collapse">
                  <thead className="text-[11px] text-slate-500 bg-slate-50/80 sticky top-0 uppercase font-bold tracking-wider z-30">
                    <tr>
                      <th className="px-4 py-4 border-b border-slate-200">Nro</th>
                      <th className="px-4 py-4 border-b border-slate-200 text-center">Ver</th>
                      <HeaderCell label="Apellidos y Nombres" colKey="nombre" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("nombre")} isFiltered={(activeFilters["nombre"]?.length || 0) > 0} />
                      <HeaderCell label="DNI" colKey="dni" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("dni")} isFiltered={(activeFilters["dni"]?.length || 0) > 0} />
                      <HeaderCell label="Estado" colKey="estado" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("estado")} isFiltered={(activeFilters["estado"]?.length || 0) > 0} center />
                      <HeaderCell label="Método" colKey="method" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("method")} isFiltered={(activeFilters["method"]?.length || 0) > 0} center />
                      <HeaderCell label="Origen" colKey="sourceFile" sortConfig={sortConfig} onSort={toggleSort} onFilter={() => setOpenFilterMenu("sourceFile")} isFiltered={(activeFilters["sourceFile"]?.length || 0) > 0} />
                      <th className="px-6 py-4 border-b border-slate-200 border-l border-slate-200 text-blue-600">DNI Sheets</th>
                      <th className="px-6 py-4 border-b border-slate-200 text-blue-600">Nombre Oficial</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {displayedData.map((row, idx) => {
                      const master = getMasterInfo(row.dni);
                      const isValid = !!master;
                      return (
                        <tr key={idx} className="hover:bg-slate-50/50 transition-colors group/row">
                          <td className="px-4 py-3 text-slate-400">{row.nro}</td>
                          <td className="px-4 py-3 text-center">
                            <button onClick={() => handleViewSource(row.sourceFile)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"><Eye size={16} /></button>
                          </td>
                          <td className="px-6 py-3 truncate max-w-[180px] text-slate-800">{highlightMatch(row.nombre, tableFilter)}</td>
                          <td className="px-6 py-3">
                            <input type="text" value={row.dni} onChange={(e) => {
                              const originalIdx = extractedData.findIndex(r => r === row);
                              const updated = [...extractedData];
                              updated[originalIdx].dni = e.target.value;
                              updated[originalIdx].method = "MANUAL";
                              setExtractedData(updated);
                            }} className={`w-full px-2 py-1 rounded border outline-none transition-all font-mono text-sm ${isValid ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`} />
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
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold border ${row.method === "IA" ? "bg-purple-100 text-purple-700" : row.method === "MANUAL" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>{row.method}</span>
                          </td>
                          <td className="px-6 py-3 text-[10px] text-slate-400 italic truncate max-w-[100px]">{row.sourceFile}</td>
                          <td className="px-6 py-3 bg-slate-50/30 border-l border-slate-100 text-slate-500 italic">{master ? master.dni : "---"}</td>
                          <td className="px-6 py-3 bg-slate-50/30 text-slate-600">{master ? master.nombre : "---"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
            <div className="absolute top-0 left-0 right-0 p-6 flex items-center justify-between bg-gradient-to-b from-black/50 to-transparent z-50 pointer-events-none">
              <div className="flex items-center gap-4 pointer-events-auto">
                <div className="p-2.5 bg-blue-600 text-white rounded-xl shadow-lg"><ImageIcon size={20} /></div>
                <div>
                  <h3 className="text-white font-semibold text-sm leading-tight">{viewingImage.name}</h3>
                  <p className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Modo de Inspección de Alta Precisión</p>
                </div>
              </div>
              <div className="flex items-center gap-2 pointer-events-auto">
                <div className="flex items-center bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 p-1 mr-2 shadow-2xl">
                  <button onClick={() => setZoomLevel(p => Math.max(0.5, p/1.2))} className="p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-xl transition-all"><ZoomOut size={20}/></button>
                  <div className="px-4 min-w-[70px] text-center"><span className="text-sm font-mono font-black text-blue-400">{(zoomLevel*100).toFixed(0)}%</span></div>
                  <button onClick={() => setZoomLevel(p => Math.min(15, p*1.2))} className="p-2.5 text-white/80 hover:text-white hover:bg-white/10 rounded-xl transition-all"><ZoomIn size={20}/></button>
                </div>
                <button onClick={resetViewer} className="p-3 bg-white/10 backdrop-blur-xl text-white/80 hover:text-white hover:bg-white/10 rounded-2xl border border-white/20 shadow-2xl transition-all" title="Reiniciar vista"><RotateCcw size={20}/></button>
                <button onClick={() => setViewingImage(null)} className="ml-2 p-3 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white rounded-2xl border border-red-500/30 shadow-2xl transition-all"><X size={24}/></button>
              </div>
            </div>

            {/* Interaction Canvas */}
            <div 
              className={`relative w-full h-full flex items-center justify-center overflow-hidden cursor-${isPanning ? 'grabbing' : 'grab'}`}
              onMouseDown={handlePanStart}
              onMouseMove={handlePanMove}
              onMouseUp={handlePanEnd}
              onMouseLeave={handlePanEnd}
            >
              <motion.img 
                src={viewingImage.url} 
                draggable={false}
                animate={{ 
                  scale: zoomLevel,
                  x: panOffset.x,
                  y: panOffset.y
                }}
                transition={{ 
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                  mass: 0.5
                }}
                className="max-w-[90%] max-h-[90%] object-contain shadow-[0_0_100px_rgba(0,0,0,0.5)] rounded-sm pointer-events-none"
              />
            </div>

            {/* Hint Overlay */}
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-6 px-8 py-4 bg-black/40 backdrop-blur-2xl rounded-3xl border border-white/10 shadow-2xl pointer-events-none opacity-60">
              <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest"><MousePointer2 size={14} className="text-blue-400" /> Rueda: Zoom</div>
              <div className="h-4 w-[1px] bg-white/10" />
              <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest"><Grab size={14} className="text-blue-400" /> Click: Arrastrar</div>
              <div className="h-4 w-[1px] bg-white/10" />
              <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest"><Maximize2 size={14} className="text-blue-400" /> Doble Click: Reset</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Search (FAB) */}
      <div className="fixed bottom-8 right-8 z-50 flex flex-col items-end gap-4">
        <AnimatePresence>
          {showSearch && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-80 overflow-hidden"><div className="p-4 bg-slate-50/50"><input autoFocus placeholder="Buscar en Sheets..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full px-4 py-2 border rounded-xl text-sm outline-none focus:border-blue-400" /></div><div className="max-h-60 overflow-y-auto p-2">{searchResults.map((m, i) => (<div key={i} className="p-3 hover:bg-blue-50 rounded-lg cursor-pointer flex flex-col" onClick={() => navigator.clipboard.writeText(m.dni)}><span className="text-xs font-bold text-slate-800 uppercase">{m.nombre}</span><span className="text-[10px] text-blue-600">DNI: {m.dni}</span></div>))}</div></motion.div>
          )}
        </AnimatePresence>
        <button onClick={() => setShowSearch(!showSearch)} className={`p-4 rounded-full shadow-2xl transition-all ${showSearch ? "bg-slate-800" : "bg-blue-600"} text-white`}>{showSearch ? <X size={24}/> : <SearchCode size={24}/>}</button>
      </div>
    </div>
  );
}

function HeaderCell({ label, colKey, sortConfig, onSort, onFilter, isFiltered, center }: any) {
  return (
    <th className={`px-6 py-4 border-b border-slate-200 relative group ${center ? "text-center" : ""}`}>
      <div className={`flex items-center gap-1.5 ${center ? "justify-center" : ""}`}>
        <span className="cursor-pointer select-none" onClick={() => onSort(colKey)}>{label}</span>
        <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={(e) => { e.stopPropagation(); onSort(colKey); }} className={`${sortConfig?.key === colKey ? "text-blue-600" : "text-slate-300"} hover:text-blue-400`}>{sortConfig?.key === colKey ? (sortConfig.direction === 'asc' ? <ArrowUp size={10}/> : <ArrowDown size={10}/>) : <ArrowUpDown size={10}/>}</button>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onFilter(); }} className={`p-1 rounded hover:bg-slate-100 transition-colors ${isFiltered ? "text-blue-600" : "text-slate-300"}`}><Filter size={10} fill={isFiltered ? "currentColor" : "none"} /></button>
      </div>
    </th>
  );
}
