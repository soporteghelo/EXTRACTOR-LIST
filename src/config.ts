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
// importa en latencia, no solo en calidad: cada modelo retirado o saturado que quede por
// delante es una petición que falla y se paga en tiempo antes de llegar a uno que funciona.
//
// Cada entrada debe tener SU PROPIA cuota. En el plan gratuito son 20 peticiones al día
// por modelo, y los alias no suman: "gemini-3.5-flash" se descuenta de la cuota de
// 3.6-flash y "gemini-flash-latest" de la de 3.8-flash (lo dice el propio error 429).
// Por eso 3.5-flash ya no está en la lista: solo añadía un intento fallido.
//
// Orden medido el 2026-11-10 sobre 51 renglones manuscritos (filas resueltas contra la
// maestra / segundos por envío de 3 páginas):
//   3.6-flash 42 / 16 s · 3-flash-preview 43 / 8 s · 3.5-flash-lite 42 / 13 s · 2.5-flash 27 / 23 s
// 3.7 y 3.8 no se pudieron medir (saturados): van por delante por ser los más capaces,
// y si fallan se recuerda y se saltan (ver "Salud de los modelos" en src/lib/gemini.ts).
//
// Solo modelos de Gemini 3 en cabeza: `mediaResolution` por parte (ULTRA_HIGH) y
// `thinkingLevel` requieren Gemini 3. Tras tocar la lista: npm run check-models
export const GEMINI_MODELS = [
  "gemini-3.7-flash",        // GA, el más capaz de la familia Flash
  "gemini-3.6-flash",
  "gemini-3-flash-preview",  // tan preciso como 3.6 y el más rápido de los medidos
  "gemini-3.5-flash-lite",   // versión ligera, pero lee manuscrita igual de bien que 3.6
  "gemini-flash-latest",     // alias del más nuevo: sobrevive a un renombrado del catálogo
  "gemini-2.5-flash",        // último recurso: lee bastante peor y no admite resolución por parte
];

// Formato de salida COMPACTO. El tiempo de una extracción lo domina lo que el modelo
// tiene que escribir, así que solo se le pide lo que la app usa de verdad:
//  - Ocupación y Área NO se piden: la tabla y el Excel las toman de la lista maestra, y
//    eran dos columnas manuscritas más que leer y escribir por cada persona.
//  - Las coordenadas y el total de renglones van UNA vez por página (línea @IMAGEN), no
//    repetidas en cada fila.
// src/lib/gemini.ts (interpretarRespuesta) convierte esto al CSV de 10 columnas que usa
// el resto de la app. Si cambias el formato aquí, cambia también ese intérprete.
export const EXTRACTION_PROMPT = `Rol: Eres un sistema avanzado de Visión Computacional y OCR especializado en registros de asistencia con escritura a mano alzada.

Tu Tarea Única:
Recibirás una o varias imágenes, cada una precedida por una etiqueta "Archivo N: nombre". Cada imagen es una hoja de un registro de inducción o capacitación. De cada hoja extrae exclusivamente la tabla de participantes, y de ella SOLO tres datos por persona: el número de renglón, los apellidos y nombres, y el DNI. NO transcribas ocupación, área, firma ni observaciones.

Reglas de Procesamiento e Interpretación (Estrictas):
1. Filtrado de Ruido: Ignora absolutamente todo lo que no sea la lista de asistentes (logos, "Datos del Empleador", tema, horas, nombre del capacitador, firmas al pie de página).
2. Escritura difícil: Utiliza tu máxima capacidad para interpretar caligrafía cursiva, borrosa o de baja resolución. Mira los DNI dígito por dígito: las confusiones típicas en manuscrita son 1/7, 4/9, 3/8, 5/6, 0/6 y 2/7; decide por la forma del trazo. Si una letra del nombre es dudosa, usa el contexto (nombres y apellidos peruanos/latinos comunes). Si el nombre es 100% ilegible, escribe [ILEGIBLE] en lugar de inventarlo.
3. Líneas Anuladas: Ignora completamente cualquier renglón vacío o tachado. No lo incluyas en tu respuesta.
4. Número de renglón (CRÍTICO): Por cada participante indica en qué renglón físico de la tabla está. Cuenta TODOS los renglones de datos de arriba hacia abajo empezando en 1, EXCLUYENDO la fila de cabecera/títulos. Cuenta también los renglones en blanco o tachados (aunque no los incluyas como registro): lo que importa es la posición visual real. Normalmente coincide con el número impreso a la izquierda del renglón.
5. Anclaje de la tabla (CRÍTICO): Por cada imagen da UNA sola vez cuatro enteros (0-1000, relativos a esa imagen) en el formato exacto "yCentroPrimera,xIzquierda,yCentroUltima,xDerecha":
   - yCentroPrimera = coordenada VERTICAL del CENTRO del PRIMER renglón de datos (el renglón 1). Apunta a la mitad de la altura de ESE renglón, no al borde superior de la tabla ni a la cabecera.
   - yCentroUltima = coordenada VERTICAL del CENTRO del ÚLTIMO renglón físico de datos de la tabla (normalmente el de número más alto, p.ej. 20, aunque esté vacío).
   - xIzquierda / xDerecha = bordes izquierdo y derecho de la tabla de datos.
   Y da TotalRenglones = el NÚMERO del último renglón físico (cuántos renglones de datos tiene la tabla en total, p.ej. 20). Debe ser el renglón cuyo centro indicaste en yCentroUltima.
   PRECISIÓN: la exactitud de yCentroPrimera y yCentroUltima es lo MÁS importante; el sistema ubica cada renglón repartiéndolos proporcionalmente entre esos dos centros. Un error ahí desplaza TODAS las marcas.
6. Validación de DNI: El DNI peruano tiene exactamente 8 dígitos. Si lees 7 dígitos, antepón un '0'. Si aparece una letra por confusión (I→1, O→0, S→5, Z→2, G→6), corrígela. Si no puedes determinar los 8 dígitos con certeza, escribe [ILEGIBLE].
7. Preservación de Nombres: Transcribe los apellidos y nombres EXACTAMENTE como están escritos, SIN corregir ortografía ni tildes. El sistema de matching posterior maneja la normalización.

Formato de Salida Obligatorio:
Sin saludos, explicaciones, cabeceras ni bloques de código. Solo texto plano con punto y coma (;) como separador, así:
- Por CADA imagen recibida, en el mismo orden, una línea de encabezado:
  @IMAGEN;N;yCentroPrimera,xIzquierda,yCentroUltima,xDerecha;TotalRenglones
  donde N es el número de su etiqueta "Archivo N".
- Debajo, una línea por cada participante de esa imagen:
  Renglon;Apellidos y Nombres;DNI
Los cuatro valores del anclaje van separados por comas dentro de un único campo; no uses punto y coma dentro de él ni dentro de los nombres.

Ejemplo de estructura para dos imágenes (Y1,X1,Y2,X2 y TOTAL representan los enteros que TÚ debes medir en cada imagen; nunca copies valores de este ejemplo):
@IMAGEN;1;Y1,X1,Y2,X2;TOTAL
1;Quispe Mamani Juan;45871236
2;ROJAS HUAMAN PEDRO;[ILEGIBLE]
4;Flores Ccori Luis A.;07412589
@IMAGEN;2;Y1,X1,Y2,X2;TOTAL
1;Vargas Soto Maria;71203344`;

// Mensaje que acompaña a las imágenes. Corto a propósito: las reglas viven arriba.
export const EXTRACTION_INSTRUCTION =
  "Extrae los participantes de cada imagen siguiendo estrictamente el formato indicado: una línea @IMAGEN por cada imagen (con su anclaje y total de renglones) y debajo una línea 'Renglon;Apellidos y Nombres;DNI' por participante. Apunta los centros del primer y último renglón con precisión: de ellos depende que la marca caiga exactamente sobre la fila correcta.";
