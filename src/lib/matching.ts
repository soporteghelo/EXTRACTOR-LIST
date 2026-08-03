// Text normalization and multi-signal name/DNI matching utilities

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function tokenize(s: string): string[] {
  return normalizeText(s).split(" ").filter(t => t.length >= 2);
}

// Strips non-digits and leading zeros from a DNI string (handles OCR letter/digit confusion)
export function normalizeDniStrict(dni: string): string {
  return dni.replace(/\D/g, "").replace(/^0+/, "");
}

// Letras que el OCR confunde con dígitos en un DNI manuscrito.
const OCR_LETRA_A_DIGITO: Record<string, string> = {
  O: "0", D: "0", Q: "0", U: "0",
  I: "1", L: "1", "|": "1",
  Z: "2", E: "3", A: "4", S: "5", G: "6", T: "7", B: "8",
};

// Igual que normalizeDniStrict pero recuperando el dígito en vez de borrar la letra:
// "1S747193" → "15747193" (strict daría "1747193", perdiendo la posición).
// Solo se usa para comparar de forma difusa, nunca para dar un DNI por válido.
export function normalizeDniOcr(dni: string): string {
  return (dni || "")
    .toUpperCase()
    .replace(/[A-Z|]/g, (ch) => OCR_LETRA_A_DIGITO[ch] ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

// Distancia de edición con transposición (Damerau-Levenshtein / OSA). Frente a la
// distancia de Hamming, "43174903" vs "43179403" cuesta 1 edición y no 2: intercambiar
// dos dígitos contiguos es de los errores más frecuentes al copiar un número.
export function editDistanceOSA(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  let cur: number[] = new Array(lb + 1);
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    prev2 = prev; prev = cur; cur = new Array(lb + 1);
  }
  return prev[lb];
}

// Jaro-Winkler similarity — better than Levenshtein for names (normalized [0,1], prefix-aware)
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(lenA, lenB) / 2) - 1, 0);
  const matchedA = new Array(lenA).fill(false);
  const matchedB = new Array(lenB).fill(false);

  let matches = 0;
  for (let i = 0; i < lenA; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, lenB);
    for (let j = start; j < end; j++) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = true;
      matchedB[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < lenA; i++) {
    if (!matchedA[i]) continue;
    while (!matchedB[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro = (matches / lenA + matches / lenB + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus (max 4 chars, scaling factor 0.1)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, lenA, lenB); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Token-set Jaccard similarity with fuzzy credit for near-matching tokens
export function tokenSetScore(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  // Exact matches in intersection
  let exactIntersection = 0;
  for (const t of setA) if (setB.has(t)) exactIntersection++;

  const union = setA.size + setB.size - exactIntersection;
  const jaccard = exactIntersection / union;

  // Fuzzy credit: for tokens not exactly matched, find best Jaro-Winkler pair
  const unmatchedA = tokensA.filter(t => !setB.has(t));
  const unmatchedB = tokensB.filter(t => !setA.has(t));
  let fuzzyCredit = 0;
  let fuzzyPairs = 0;
  const usedB = new Set<string>();
  for (const ta of unmatchedA) {
    let best = 0;
    let bestTb = "";
    for (const tb of unmatchedB) {
      if (usedB.has(tb)) continue;
      const sim = jaroWinkler(ta, tb);
      if (sim > best) { best = sim; bestTb = tb; }
    }
    if (best >= 0.82) {
      fuzzyCredit += best / (union + 1);
      fuzzyPairs++;
      usedB.add(bestTb);
    }
  }

  const jaccardScore = Math.min(1, jaccard + fuzzyCredit);

  // Que falte el segundo nombre ("PEÑA LEON DAVID" vs "PEÑA LEON DAVID RAFAEL") es
  // sistemático en estas fichas, no una discrepancia: Jaccard lo castiga por el simple
  // hecho de que un lado tenga más tokens. La contención mide cuánto del lado corto
  // está contenido en el largo. Se exige un mínimo de 2 tokens en común para que un
  // apellido suelto no dispare la puntuación.
  const matched = exactIntersection + fuzzyPairs;
  if (matched < 2) return jaccardScore;
  const containment = matched / Math.min(setA.size, setB.size);
  return Math.min(1, Math.max(jaccardScore, 0.6 * jaccardScore + 0.4 * containment));
}

// Clave fonética para castellano: colapsa las confusiones que de verdad ocurren al
// escribir a mano un apellido ("BALBERDE"/"VALVERDE", "GONZALES"/"GONZALEZ",
// "UARCAYA"/"HUARCAYA", "YSABEL"/"ISABEL"). Dos grafías que suenan igual comparten clave.
export function spanishPhoneticKey(word: string): string {
  let w = normalizeText(word).toUpperCase().replace(/[^A-Z]/g, "");
  if (!w) return "";
  w = w.replace(/CH/g, "1");              // dígrafos primero, como símbolos propios
  w = w.replace(/LL/g, "Y");
  w = w.replace(/RR/g, "R");
  w = w.replace(/QU/g, "K");
  w = w.replace(/GU([EI])/g, "G$1");
  w = w.replace(/H/g, "");                // hache muda
  w = w.replace(/C([EI])/g, "S$1");       // seseo: ce/ci = se/si
  w = w.replace(/[CK]/g, "K");
  w = w.replace(/[ZX]/g, "S");            // seseo: z = s
  w = w.replace(/G([EI])/g, "J$1");       // ge/gi = je/ji
  w = w.replace(/[VW]/g, "B");            // b = v
  w = w.replace(/Y/g, "I");               // yeísmo + y/i
  w = w.replace(/(.)\1+/g, "$1");         // letras repetidas
  return w;
}

// Cada nombre de la maestra se compara contra todas las filas del documento: sin caché
// se recalcularían las mismas claves fonéticas decenas de miles de veces.
const cacheFonetica = new Map<string, string[]>();

export function phoneticTokens(s: string): string[] {
  const hit = cacheFonetica.get(s);
  if (hit) return hit;
  const out = tokenize(s).map(spanishPhoneticKey).filter(Boolean);
  if (cacheFonetica.size < 5000) cacheFonetica.set(s, out);
  return out;
}

// Composite name match: 40% Jaro-Winkler on full string + 60% token-set (order-agnostic),
// reforzado con la variante fonética para no penalizar faltas de ortografía que suenan igual.
export function nameMatchScore(query: string, candidate: string): number {
  const nq = normalizeText(query);
  const nc = normalizeText(candidate);
  if (nq === nc) return 1;

  const literal = 0.4 * jaroWinkler(nq, nc) + 0.6 * tokenSetScore(tokenize(nq), tokenize(nc));

  const pq = phoneticTokens(nq);
  const pc = phoneticTokens(nc);
  const fonetico = 0.4 * jaroWinkler(pq.join(" "), pc.join(" ")) + 0.6 * tokenSetScore(pq, pc);

  // Coincidir en fonética es evidencia casi tan fuerte como coincidir en letra.
  return Math.max(literal, 0.96 * fonetico);
}

// Fusiona las dos señales independientes (DNI y nombre). Dos indicios medios apuntando
// a la misma persona valen más que uno solo: un DNI con 2 dígitos mal (0.75) junto a un
// nombre a medio leer (0.70) da 0.80, suficiente para resolver sin intervención.
// Cada señal por separado conserva su comportamiento anterior gracias al max().
export function combinedMatchScore(dniScore: number, nameScore: number): number {
  // El tope es necesario: la suma ponderada de dos señales fuertes pasa de 1.
  return Math.min(1, Math.max(dniScore, nameScore, 0.55 * (dniScore + nameScore)));
}

// DNI fuzzy score — tolera errores de OCR en un DNI peruano de 8 dígitos:
// letras confundidas con cifras, sustituciones, dígitos perdidos y transposiciones.
// La escala se mantiene: 1 error sobre 8 dígitos = 0.875.
export function dniFuzzyScore(dniA: string, dniB: string): number {
  const a = normalizeDniOcr(dniA);
  const b = normalizeDniOcr(dniB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.abs(a.length - b.length) > 2) return 0;
  const edits = editDistanceOSA(a, b);
  return Math.max(0, 1 - edits / Math.max(a.length, b.length, 8));
}

export function confidenceLevel(score: number): "high" | "medium" | "low" {
  if (score >= 0.92) return "high";
  if (score >= 0.78) return "medium";
  return "low";
}
