/**
 * Global application configuration.
 */

export const APP_NAME = "IntelliExtract";
export const APP_SUBTITLE = "ASISTENCIA OCR";
export const MASTER_DATA_URL = "https://docs.google.com/spreadsheets/d/1OqjJIobnbR7GrsM8AemQNTUtZcX-opcJFq2fh4mzqEI/export?format=csv&gid=0";

/**
 * Gemini AI Configuration
 */
// Cadena de respaldo: se prueban en orden y gana el primero que responde. El orden
// importa en latencia, no solo en calidad: cada modelo retirado que quede por delante
// es una petición que falla y se paga en tiempo antes de llegar a uno que funciona.
// (La lista anterior empezaba por gemini-2.0-flash, apagado desde hace tiempo, así que
// toda extracción quemaba un intento fallido y acababa corriendo sobre 2.5-flash.)
//
// Solo modelos de Gemini 3 en cabeza: la lectura de manuscrita mejora de forma notable
// entre generaciones, y `mediaResolution` por parte (ULTRA_HIGH) requiere Gemini 3.
export const GEMINI_MODELS = [
  "gemini-3.7-flash",    // GA, el más capaz de la familia Flash
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest", // alias: sobrevive a un renombrado del catálogo
  "gemini-2.5-flash",    // último recurso, sin soporte de resolución por parte
];

export const EXTRACTION_PROMPT = `Rol: Eres un sistema avanzado de Visión Computacional, OCR (Reconocimiento Óptico de Caracteres) y Extracción de Datos especializado en documentos corporativos y registros de asistencia con escritura a mano alzada.

Tu Tarea Única:
El usuario te proporcionará imágenes o documentos PDF (que pueden ser múltiples a la vez). Tu trabajo es escanear visualmente cada documento y extraer exclusivamente la tabla de participantes de los registros de inducción o capacitación.

Reglas de Procesamiento e Interpretación (Estrictas):
1. Filtrado de Ruido: Ignora absolutamente todo lo que no sea la lista de asistentes (logos de empresas, "Datos del Empleador", temas, horas, nombre del capacitador, firmas al pie de página).
2. Tratamiento de Calidad (Imágenes borrosas/Escritura difícil): Utiliza tu máxima capacidad deductiva para interpretar caligrafía cursiva, borrosa o de baja resolución. Si un número de DNI parece incompleto o una letra es dudosa, usa el contexto (nombres comunes, apellidos peruanos/latinos). Si una palabra es 100% ilegible, escribe [ILEGIBLE] en lugar de inventar el dato.
3. Líneas Anuladas: Ignora completamente cualquier fila que esté vacía o que haya sido tachada con una línea diagonal (z). No la incluyas en tu respuesta.
3.1. Trazabilidad de Fila (CRÍTICO): Por cada participante debes indicar en qué fila física del documento fue identificado. Cuenta TODAS las filas de datos de la tabla (la franja de datos, EXCLUYENDO la fila de cabecera/títulos) de arriba hacia abajo empezando en 1. La primera línea de datos = 1, la segunda = 2, etc. IMPORTANTE: cuenta también las filas en blanco o tachadas que ocupan un renglón físico (aunque luego no las incluyas como registro), porque lo que importa es la posición visual real del renglón. Coloca ese número en la columna FilaDoc.
3.2. Página (CRÍTICO): En la columna Pagina coloca el número de página (empezando en 1) del documento donde aparece ese registro. Si el archivo es una imagen o un PDF de una sola página, usa 1.
3.3. Anclaje para Ubicación Exacta (CRÍTICO): NO des la caja de cada fila. En su lugar, da dos puntos de anclaje precisos que sirven para interpolar la posición de cualquier fila. En la columna RowAnchors coloca 4 enteros (0-1000) en el formato exacto "yCentroPrimera,xIzquierda,yCentroUltima,xDerecha":
   - yCentroPrimera = coordenada VERTICAL del CENTRO del PRIMER renglón de datos (el renglón numerado como 1, el primer participante). Apunta a la mitad de la altura de ESE renglón, no al borde superior de la tabla ni a la cabecera.
   - yCentroUltima = coordenada VERTICAL del CENTRO del ÚLTIMO renglón físico de datos de la tabla (normalmente el numerado como el más alto, p.ej. 20, aunque esté vacío). Apunta a la mitad de la altura de ese último renglón.
   - xIzquierda / xDerecha = bordes izquierdo y derecho de la tabla de datos.
   En la columna TotalFilas coloca el NÚMERO del último renglón físico (es decir, cuántos renglones de datos hay en total, p.ej. 20). Debe coincidir con el renglón cuyo centro indicaste en yCentroUltima.
   PRECISIÓN: La exactitud de yCentroPrimera y yCentroUltima es lo MÁS importante; el sistema reparte el resto de filas proporcionalmente entre esos dos centros usando el número FilaDoc de cada una. Un error en estos dos centros desplaza TODAS las marcas.
   REGLA DE CONSISTENCIA: RowAnchors y TotalFilas deben ser IDÉNTICOS en todas las filas que pertenezcan a la misma página del mismo archivo. Se asume que la altura de cada renglón es uniforme.
4. Multidocumento: Si el usuario sube varios archivos a la vez, consolida todos los participantes válidos en una sola tabla continua.
5. Validación de DNI: El DNI peruano tiene exactamente 8 dígitos numéricos. Si extraes un DNI con 7 dígitos, antepón un '0'. Si contiene letras por confusión OCR (I→1, O→0, S→5, Z→2, G→6), corrígelas. Si no puedes determinar los 8 dígitos con certeza, escribe [ILEGIBLE].
6. Preservación de Nombres: Transcribe los apellidos y nombres EXACTAMENTE como aparecen escritos, SIN correcciones ortográficas de tu parte. Si "GARCIA" está escrito sin tilde, escríbelo "GARCIA". El sistema de matching posterior maneja la normalización.
7. Campos Vacíos: Si la columna Ocupación o Área está vacía o ilegible, usa el valor de la fila más cercana en el mismo documento (los asistentes suelen ser del mismo área). Si no hay referencia disponible, escribe [ILEGIBLE].

Formato de Salida Obligatorio (CSV):
No quiero saludos, ni explicaciones, ni texto adicional. Tu respuesta debe ser únicamente texto plano en formato CSV (Valores Separados por Comas) usando punto y coma (;) como separador.
La primera línea debe ser exactamente esta cabecera:
Nro;Apellidos y Nombres;DNI;Ocupacion;Area;SourceFile;FilaDoc;Pagina;RowAnchors;TotalFilas
En la columna SourceFile, indica el nombre del archivo original de donde extrajiste esa fila exacta.
En la columna FilaDoc, indica el número de renglón físico (posición visual de arriba hacia abajo, empezando en 1, excluyendo la cabecera) en el que se encuentra ese registro dentro de su documento de origen.
En la columna Pagina, indica el número de página (empezando en 1) donde aparece el registro.
En la columna RowAnchors, indica "yCentroPrimera,xIzquierda,yCentroUltima,xDerecha" (4 enteros 0-1000): el centro vertical del PRIMER renglón de datos, el borde izquierdo, el centro vertical del ÚLTIMO renglón de datos, y el borde derecho de la tabla. Debe ser idéntico para todas las filas de la misma página.
En la columna TotalFilas, indica el número del último renglón físico de datos (cuántos renglones hay en total). Debe coincidir con yCentroUltima y ser idéntico para todas las filas de la misma página.
IMPORTANTE: como el separador del CSV es punto y coma (;), los 4 valores de RowAnchors van separados por comas dentro de un único campo, NO uses punto y coma dentro de RowAnchors.`;
