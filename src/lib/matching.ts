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
      usedB.add(bestTb);
    }
  }

  return Math.min(1, jaccard + fuzzyCredit);
}

// Composite name match: 40% Jaro-Winkler on full string + 60% token-set (order-agnostic)
export function nameMatchScore(query: string, candidate: string): number {
  const nq = normalizeText(query);
  const nc = normalizeText(candidate);
  if (nq === nc) return 1;
  const jw = jaroWinkler(nq, nc);
  const ts = tokenSetScore(tokenize(nq), tokenize(nc));
  return 0.4 * jw + 0.6 * ts;
}

// DNI fuzzy score — handles 1-digit OCR errors on 8-digit Peruvian DNIs
export function dniFuzzyScore(dniA: string, dniB: string): number {
  const a = normalizeDniStrict(dniA);
  const b = normalizeDniStrict(dniB);
  if (!a || !b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 0;

  if (a.length === b.length) {
    // Hamming distance (same length)
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return 1 - diff / Math.max(a.length, 8);
  }

  // Edit distance for length-1 difference (insertions/deletions only)
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; }
    else { j++; edits++; }
  }
  edits += longer.length - j;
  return 1 - edits / Math.max(longer.length, 8);
}

export function confidenceLevel(score: number): "high" | "medium" | "low" {
  if (score >= 0.92) return "high";
  if (score >= 0.78) return "medium";
  return "low";
}
