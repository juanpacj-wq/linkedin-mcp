import fs from "node:fs";
import path from "node:path";
import { PATHS, DAILY_LIMITS, ensureDirs, type LimitKey } from "../config.js";
import { log } from "../logger.js";
import { normalizeLabel, bestScore, overlapScore, asksDifferentThing } from "../text.js";

export { normalizeLabel };

export interface ApplicationRecord {
  jobId: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  appliedAt: string;
  status: "applied" | "dry-run" | "failed" | "skipped" | "external";
  notes?: string;
  questionsAnswered?: Record<string, string>;
}

export interface OutreachRecord {
  kind: "invitation" | "message" | "comment" | "reaction" | "follow" | "post" | "endorsement";
  target: string;
  at: string;
  detail?: string;
}

interface StateShape {
  counters: Record<string, Partial<Record<LimitKey, number>>>;
  applications: ApplicationRecord[];
  outreach: OutreachRecord[];
  lastLoginCheck?: string;
  profileSnapshot?: unknown;
}

const EMPTY: StateShape = { counters: {}, applications: [], outreach: [] };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function read(): StateShape {
  try {
    if (!fs.existsSync(PATHS.state)) return structuredClone(EMPTY);
    const parsed = JSON.parse(fs.readFileSync(PATHS.state, "utf8")) as Partial<StateShape>;
    return {
      counters: parsed.counters ?? {},
      applications: parsed.applications ?? [],
      outreach: parsed.outreach ?? [],
      ...(parsed.lastLoginCheck ? { lastLoginCheck: parsed.lastLoginCheck } : {}),
      ...(parsed.profileSnapshot ? { profileSnapshot: parsed.profileSnapshot } : {}),
    };
  } catch (err) {
    log.warn("state.json ilegible, se reinicia", String(err));
    return structuredClone(EMPTY);
  }
}

function write(state: StateShape): void {
  ensureDirs();
  const tmp = PATHS.state + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, PATHS.state);
}

export function getState(): StateShape {
  return read();
}

export function usageToday(): Record<LimitKey, { used: number; limit: number; left: number }> {
  const state = read();
  const day = state.counters[today()] ?? {};
  const out = {} as Record<LimitKey, { used: number; limit: number; left: number }>;
  for (const key of Object.keys(DAILY_LIMITS) as LimitKey[]) {
    const used = day[key] ?? 0;
    const limit = DAILY_LIMITS[key];
    out[key] = { used, limit, left: Math.max(0, limit - used) };
  }
  return out;
}

/** Lanza si la acción supera el tope diario. Llamar ANTES de ejecutar. */
export function assertWithinLimit(key: LimitKey, count = 1): void {
  const usage = usageToday()[key];
  if (usage.used + count > usage.limit) {
    throw new Error(
      `Tope diario alcanzado para "${key}": ${usage.used}/${usage.limit}. ` +
        `Se reinicia mañana. Puedes subirlo con la variable de entorno correspondiente, ` +
        `pero los topes bajos son lo que evita que LinkedIn restrinja la cuenta.`,
    );
  }
}

export function recordUsage(key: LimitKey, count = 1): void {
  const state = read();
  const day = today();
  const bucket = state.counters[day] ?? {};
  bucket[key] = (bucket[key] ?? 0) + count;
  state.counters[day] = bucket;
  // Conserva solo 60 días de contadores.
  const days = Object.keys(state.counters).sort();
  while (days.length > 60) {
    const oldest = days.shift();
    if (oldest) delete state.counters[oldest];
  }
  write(state);
}

export function recordApplication(record: ApplicationRecord): void {
  const state = read();
  state.applications = state.applications.filter((a) => a.jobId !== record.jobId);
  state.applications.unshift(record);
  write(state);
}

export function hasApplied(jobId: string): ApplicationRecord | undefined {
  return read().applications.find((a) => a.jobId === jobId && a.status === "applied");
}

export function listApplications(limit = 50): ApplicationRecord[] {
  return read().applications.slice(0, limit);
}

export function recordOutreach(record: OutreachRecord): void {
  const state = read();
  state.outreach.unshift(record);
  state.outreach = state.outreach.slice(0, 1000);
  write(state);
}

export function listOutreach(limit = 50): OutreachRecord[] {
  return read().outreach.slice(0, limit);
}

export function saveProfileSnapshot(snapshot: unknown): void {
  const state = read();
  state.profileSnapshot = snapshot;
  write(state);
}

/* ------------------------------------------------------------------ */
/* Banco de respuestas para formularios de postulación                 */
/* ------------------------------------------------------------------ */

export interface AnswerBank {
  /** Datos de contacto y campos comunes. */
  profile: Record<string, string>;
  /** Respuestas por pregunta, indexadas por texto normalizado de la etiqueta. */
  answers: Record<string, string>;
  /** Ruta al CV por defecto. */
  defaultResume?: string;
  /** Rutas a documentos adicionales (portafolio, cartas). */
  documents?: Record<string, string>;
}

const EMPTY_BANK: AnswerBank = { profile: {}, answers: {} };

export function readAnswerBank(): AnswerBank {
  try {
    if (!fs.existsSync(PATHS.answers)) return structuredClone(EMPTY_BANK);
    const parsed = JSON.parse(fs.readFileSync(PATHS.answers, "utf8")) as Partial<AnswerBank>;
    return {
      profile: parsed.profile ?? {},
      answers: parsed.answers ?? {},
      ...(parsed.defaultResume ? { defaultResume: parsed.defaultResume } : {}),
      ...(parsed.documents ? { documents: parsed.documents } : {}),
    };
  } catch (err) {
    log.warn("answers.json ilegible", String(err));
    return structuredClone(EMPTY_BANK);
  }
}

export function writeAnswerBank(bank: AnswerBank): void {
  ensureDirs();
  const tmp = PATHS.answers + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(bank, null, 2), "utf8");
  fs.renameSync(tmp, PATHS.answers);
}

export function rememberAnswer(label: string, value: string): void {
  const bank = readAnswerBank();
  bank.answers[normalizeLabel(label)] = value;
  writeAnswerBank(bank);
}

/**
 * Busca la respuesta guardada para una etiqueta. Primero exacta, luego por
 * solapamiento de palabras (para preguntas que cambian de redacción entre
 * empresas pero preguntan lo mismo).
 */
export function lookupAnswer(label: string, bank = readAnswerBank()): string | undefined {
  const key = normalizeLabel(label);
  if (!key) return undefined;

  const direct = bank.answers[key];
  if (direct !== undefined) return direct;

  // Las empresas redactan la misma pregunta de mil formas, y en dos idiomas.
  // Si la pregunta nombra otra tecnología u otro país, mejor dejarla sin
  // responder que contestar en falso. Al elegir también pesa cuánto se parece
  // la redacción literal, para que una pregunta en inglés tome la respuesta
  // guardada en inglés (USD) y no la de español (COP).
  let best: { value: string; rank: number } | undefined;
  for (const [candidate, value] of Object.entries(bank.answers)) {
    const score = bestScore(label, candidate);
    if (score < 0.6 || asksDifferentThing(label, candidate)) continue;
    const rank = score + overlapScore(key, candidate);
    if (!best || rank > best.rank) best = { value, rank };
  }
  return best?.value;
}

export function resolveDocument(nameOrPath: string): string | undefined {
  const bank = readAnswerBank();
  if (fs.existsSync(nameOrPath)) return path.resolve(nameOrPath);
  const fromBank = bank.documents?.[nameOrPath];
  if (fromBank && fs.existsSync(fromBank)) return path.resolve(fromBank);
  const inDocs = path.join(PATHS.documents, nameOrPath);
  if (fs.existsSync(inDocs)) return inDocs;
  return undefined;
}
