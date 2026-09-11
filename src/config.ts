import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Raíz de datos persistentes. Se puede mover con LINKEDIN_PILOT_HOME. */
export const DATA_HOME =
  process.env.LINKEDIN_PILOT_HOME?.trim() ||
  path.join(os.homedir(), ".linkedin-pilot");

export const PATHS = {
  home: DATA_HOME,
  /** user-data-dir de Chrome: aquí viven las cookies de sesión (li_at, JSESSIONID). */
  browserProfile: path.join(DATA_HOME, "browser-profile"),
  state: path.join(DATA_HOME, "state.json"),
  answers: path.join(DATA_HOME, "answers.json"),
  logs: path.join(DATA_HOME, "logs"),
  screenshots: path.join(DATA_HOME, "screenshots"),
  downloads: path.join(DATA_HOME, "downloads"),
  documents: path.join(DATA_HOME, "documents"),
} as const;

export function ensureDirs(): void {
  for (const dir of [
    PATHS.home,
    PATHS.browserProfile,
    PATHS.logs,
    PATHS.screenshots,
    PATHS.downloads,
    PATHS.documents,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on", "si", "sí"].includes(raw.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  /** Headless rompe la detección de LinkedIn con más frecuencia: por defecto, ventana visible. */
  headless: envFlag("LINKEDIN_PILOT_HEADLESS", false),
  /** 'chrome' | 'msedge' | 'chromium' (bundled). */
  channel: process.env.LINKEDIN_PILOT_CHANNEL?.trim() || "chrome",
  locale: process.env.LINKEDIN_PILOT_LOCALE?.trim() || "es-CO",
  timezone: process.env.LINKEDIN_PILOT_TZ?.trim() || "America/Bogota",
  /** Milisegundos de espera por defecto en acciones de página. */
  actionTimeout: envInt("LINKEDIN_PILOT_ACTION_TIMEOUT", 20_000),
  navTimeout: envInt("LINKEDIN_PILOT_NAV_TIMEOUT", 45_000),
  /** Ritmo humano: rango de pausa entre acciones (ms). */
  minDelay: envInt("LINKEDIN_PILOT_MIN_DELAY", 700),
  maxDelay: envInt("LINKEDIN_PILOT_MAX_DELAY", 2_200),
  /**
   * Si es true, toda acción que sale hacia afuera (invitaciones, mensajes,
   * postulaciones, publicaciones) exige `confirm: true` explícito.
   */
  requireConfirm: envFlag("LINKEDIN_PILOT_REQUIRE_CONFIRM", true),
  /** Cierra el navegador tras N minutos de inactividad. 0 = nunca. */
  idleShutdownMinutes: envInt("LINKEDIN_PILOT_IDLE_MINUTES", 0),
  verbose: envFlag("LINKEDIN_PILOT_VERBOSE", false),
} as const;

/**
 * Topes diarios conservadores. LinkedIn restringe cuentas que superan estos
 * volúmenes; quedarse por debajo es lo que mantiene la cuenta sana.
 */
export const DAILY_LIMITS = {
  invitations: envInt("LINKEDIN_PILOT_MAX_INVITATIONS", 20),
  /** Aceptar, ignorar o retirar. No gasta el cupo de invitaciones enviadas. */
  invitationResponses: envInt("LINKEDIN_PILOT_MAX_INVITATION_RESPONSES", 100),
  endorsements: envInt("LINKEDIN_PILOT_MAX_ENDORSEMENTS", 20),
  messages: envInt("LINKEDIN_PILOT_MAX_MESSAGES", 25),
  applications: envInt("LINKEDIN_PILOT_MAX_APPLICATIONS", 20),
  reactions: envInt("LINKEDIN_PILOT_MAX_REACTIONS", 50),
  comments: envInt("LINKEDIN_PILOT_MAX_COMMENTS", 15),
  follows: envInt("LINKEDIN_PILOT_MAX_FOLLOWS", 30),
  profileViews: envInt("LINKEDIN_PILOT_MAX_PROFILE_VIEWS", 100),
  posts: envInt("LINKEDIN_PILOT_MAX_POSTS", 3),
} as const;

export type LimitKey = keyof typeof DAILY_LIMITS;

export const LINKEDIN = {
  base: "https://www.linkedin.com",
  feed: "https://www.linkedin.com/feed/",
  me: "https://www.linkedin.com/in/me/",
  jobs: "https://www.linkedin.com/jobs/",
  voyager: "https://www.linkedin.com/voyager/api",
} as const;
