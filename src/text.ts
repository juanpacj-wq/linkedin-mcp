/**
 * Emparejado de etiquetas. LinkedIn sirve la interfaz en el idioma de la
 * cuenta y cambia la redacción de los formularios sin avisar, así que todo el
 * proyecto identifica los campos por su etiqueta visible normalizada y por sus
 * equivalentes conocidos, nunca por clases CSS.
 */

/** Minúsculas, sin tildes ni puntuación, con espacios colapsados. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Glosario bilingüe: cada grupo son formas equivalentes del mismo campo.
 * Un campo pedido como "Titular" tiene que encontrar "Headline" y al revés.
 */
export const FIELD_SYNONYMS: string[][] = [
  ["titular", "headline", "encabezado"],
  ["acerca de", "about", "informacion", "summary", "extracto"],
  ["nombre", "first name", "nombres"],
  ["apellidos", "last name", "apellido", "surname"],
  ["segundo nombre", "middle name"],
  ["pronombres", "pronouns"],
  ["cargo", "title", "job title", "puesto", "position"],
  ["empresa", "company", "company name", "organizacion", "organization"],
  ["ubicacion", "location", "ciudad", "city", "localidad"],
  ["pais region", "country region", "pais", "country", "region"],
  ["tipo de empleo", "employment type"],
  ["tipo de ubicacion", "location type", "workplace type", "modalidad"],
  ["descripcion", "description"],
  ["fecha de inicio", "start date", "inicio", "from"],
  ["fecha de finalizacion", "end date", "fecha de fin", "to"],
  ["mes", "month"],
  ["ano", "year", "anio"],
  ["centro educativo", "school", "institucion", "universidad", "college"],
  ["titulo", "degree", "grado"],
  ["disciplina academica", "field of study", "campo de estudio", "especialidad"],
  ["nota media", "grade", "promedio"],
  ["aptitud", "skill", "habilidad", "competencia"],
  ["sector", "industry"],
  ["idioma", "language"],
  ["nivel de competencia", "proficiency", "nivel"],
  ["organizacion emisora", "issuing organization", "entidad emisora", "issuer"],
  ["fecha de emision", "issue date", "fecha de expedicion"],
  ["fecha de caducidad", "expiration date", "fecha de vencimiento"],
  ["id de la credencial", "credential id"],
  ["url de la credencial", "credential url"],
  ["correo electronico", "email", "email address", "correo"],
  ["telefono", "phone", "phone number", "mobile phone number", "numero de telefono", "celular"],
  ["codigo de pais", "country code"],
  ["sitio web", "website", "url"],
  ["cargos", "job titles"],
  ["ubicaciones", "locations", "lugares"],
  ["tipos de empleo", "job types"],
  ["quien puede ver", "who can see", "visibilidad", "visibility"],
  ["curriculum", "resume", "cv", "hoja de vida"],
  ["carta de presentacion", "cover letter"],
  ["anos de experiencia", "years of experience"],
  ["disponibilidad para empezar", "when can you start", "notice period", "preaviso"],
  ["pretension salarial", "expected salary", "salary expectation", "aspiracion salarial"],
  ["autorizacion de trabajo", "work authorization", "authorized to work"],
  ["requiere patrocinio", "require sponsorship", "visa sponsorship"],
];

/**
 * ¿Aparece `needle` dentro de `haystack` como secuencia de palabras completas?
 *
 * Comparar por subcadena suelta no sirve: términos cortos como "to" o "no"
 * aparecen dentro de "favorito" o "nombre" y emparejan campos que no tienen
 * nada que ver. Aquí solo cuenta si coinciden palabras enteras y seguidas.
 */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const hay = haystack.split(" ").filter(Boolean);
  const need = needle.split(" ").filter(Boolean);
  if (need.length === 0 || need.length > hay.length) return false;
  for (let i = 0; i + need.length <= hay.length; i++) {
    let all = true;
    for (let j = 0; j < need.length; j++) {
      if (hay[i + j] !== need[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** Todas las formas equivalentes de una etiqueta, ya normalizadas. */
export function expandLabel(label: string): Set<string> {
  const norm = normalizeLabel(label);
  const out = new Set<string>([norm]);
  if (!norm) return out;
  for (const group of FIELD_SYNONYMS) {
    const hit = group.some(
      (term) => norm === term || containsPhrase(norm, term) || containsPhrase(term, norm),
    );
    if (hit) for (const term of group) out.add(term);
  }
  return out;
}

/** Proporción de palabras significativas compartidas entre dos etiquetas. */
export function overlapScore(a: string, b: string): number {
  const wordsA = new Set(a.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(b.split(" ").filter((w) => w.length > 2));
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

/** Mejor puntuación entre dos etiquetas considerando sus equivalentes. */
export function bestScore(a: string, b: string): number {
  const normA = normalizeLabel(a);
  const normB = normalizeLabel(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const formsA = expandLabel(a);
  const formsB = expandLabel(b);
  for (const fa of formsA) {
    if (fa && formsB.has(fa)) return 1;
  }

  let score = 0;
  for (const fa of formsA) {
    for (const fb of formsB) {
      if (!fa || !fb) continue;
      if (containsPhrase(fa, fb) || containsPhrase(fb, fa)) score = Math.max(score, 0.9);
      score = Math.max(score, overlapScore(fa, fb));
    }
  }
  return score;
}

/** Palabras de relleno de las preguntas, en español e inglés. */
const QUESTION_STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "are", "have", "has", "with", "how", "many",
  "much", "what", "which", "does", "did", "can", "will", "would", "now", "future",
  "this", "that", "any", "our", "from", "into", "currently",
  "que", "cual", "cuales", "cuantos", "cuantas", "tienes", "tiene", "tus", "con",
  "para", "por", "del", "los", "las", "una", "uno", "estas", "esta", "eres", "hay",
  "como", "sobre", "puedes", "podrias", "nos", "mas", "actualmente",
]);

/** Palabras que dicen de qué trata la pregunta, sin relleno ni términos del glosario. */
function subjectWords(norm: string, ignore: Set<string>): Set<string> {
  return new Set(
    norm.split(" ").filter((w) => w.length > 2 && !QUESTION_STOPWORDS.has(w) && !ignore.has(w)),
  );
}

/**
 * ¿Preguntan por cosas distintas? Pasa cuando cada etiqueta nombra algo que
 * la otra no: "experiencia con Java" frente a "experiencia con Python", o
 * "trabajar en Canadá" frente a "trabajar en Colombia". El glosario las hace
 * parecer la misma pregunta, pero reutilizar la respuesta sería contestar en
 * falso. Si solo una de las dos tiene palabras de más, es otra redacción.
 */
export function asksDifferentThing(a: string, b: string): boolean {
  const normA = normalizeLabel(a);
  const normB = normalizeLabel(b);
  const formsA = expandLabel(a);
  const formsB = expandLabel(b);
  const glossary = new Set<string>();
  for (const group of FIELD_SYNONYMS) {
    if (group.some((t) => formsA.has(t)) && group.some((t) => formsB.has(t))) {
      for (const term of group) for (const w of term.split(" ")) glossary.add(w);
    }
  }
  const wordsA = subjectWords(normA, glossary);
  const wordsB = subjectWords(normB, glossary);
  const onlyA = [...wordsA].some((w) => !wordsB.has(w));
  const onlyB = [...wordsB].some((w) => !wordsA.has(w));
  return onlyA && onlyB;
}
