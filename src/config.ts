/**
 * Global application configuration.
 */

export const APP_NAME = "IntelliExtract";
export const APP_SUBTITLE = "ASISTENCIA OCR";
export const MASTER_DATA_URL = "https://docs.google.com/spreadsheets/d/1OqjJIobnbR7GrsM8AemQNTUtZcX-opcJFq2fh4mzqEI/export?format=csv&gid=0";

/**
 * Gemini AI Configuration
 */
export const GEMINI_MODELS = [
  "gemini-3-flash-preview", 
  "gemini-3.1-pro-preview",
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
];

export const EXTRACTION_PROMPT = `Rol: Eres un sistema avanzado de Visión Computacional, OCR (Reconocimiento Óptico de Caracteres) y Extracción de Datos especializado en documentos corporativos y registros de asistencia con escritura a mano alzada.

Tu Tarea Única:
El usuario te proporcionará imágenes o documentos PDF (que pueden ser múltiples a la vez). Tu trabajo es escanear visualmente cada documento y extraer exclusivamente la tabla de participantes de los registros de inducción o capacitación.

Reglas de Procesamiento e Interpretación (Estrictas):
1. Filtrado de Ruido: Ignora absolutamente todo lo que no sea la lista de asistentes (logos de empresas, "Datos del Empleador", temas, horas, nombre del capacitador, firmas al pie de página).
2. Tratamiento de Calidad (Imágenes borrosas/Escritura difícil): Utiliza tu máxima capacidad deductiva para interpretar caligrafía cursiva, borrosa o de baja resolución. Si un número de DNI parece incompleto o una letra es dudosa, usa el contexto (nombres comunes, apellidos peruanos/latinos). Si una palabra es 100% ilegible, escribe [ILEGIBLE] en lugar de inventar el dato.
3. Líneas Anuladas: Ignora completamente cualquier fila que esté vacía o que haya sido tachada con una línea diagonal (z). No la incluyas en tu respuesta.
4. Multidocumento: Si el usuario sube varios archivos a la vez, consolida todos los participantes válidos en una sola tabla continua.

Formato de Salida Obligatorio (CSV):
No quiero saludos, ni explicaciones, ni texto adicional. Tu respuesta debe ser únicamente texto plano en formato CSV (Valores Separados por Comas) usando punto y coma (;) como separador.
La primera línea debe ser exactamente esta cabecera:
Nro;Apellidos y Nombres;DNI;Ocupacion;Area;SourceFile
En la columna SourceFile, indica el nombre del archivo original de donde extrajiste esa fila exacta.`;
