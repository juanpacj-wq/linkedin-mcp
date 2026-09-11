import fs from "node:fs";
import path from "node:path";
import { PATHS, CONFIG, ensureDirs } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

let stream: fs.WriteStream | null = null;

function file(): fs.WriteStream {
  if (!stream) {
    ensureDirs();
    const day = new Date().toISOString().slice(0, 10);
    stream = fs.createWriteStream(path.join(PATHS.logs, `${day}.log`), {
      flags: "a",
    });
  }
  return stream;
}

function write(level: Level, msg: string, extra?: unknown): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(extra === undefined ? {} : { extra }),
  });
  try {
    file().write(line + "\n");
  } catch {
    /* el log en disco nunca debe tumbar una herramienta */
  }
  // stdout está reservado para el protocolo MCP: todo diagnóstico va a stderr.
  if (level === "error" || level === "warn" || CONFIG.verbose) {
    process.stderr.write(`[linkedin-pilot] ${level}: ${msg}\n`);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => write("debug", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  error: (m: string, e?: unknown) => write("error", m, e),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
