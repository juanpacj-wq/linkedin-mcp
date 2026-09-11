import { LINKEDIN } from "../config.js";
import { getContext, getCsrfToken } from "../browser/session.js";
import { log } from "../logger.js";

/**
 * Cliente de la API interna (Voyager) que reutiliza la sesión del navegador.
 *
 * Ventaja frente a copiar cookies a un cliente HTTP aparte: las peticiones
 * salen del mismo contexto que la navegación real (mismas cookies, mismo
 * user-agent, misma IP), así que LinkedIn las ve coherentes con la sesión.
 *
 * Advertencia: Voyager no es una API pública. LinkedIn cambia rutas y formas
 * sin avisar. Por eso aquí es solo un atajo de lectura; todas las escrituras
 * importantes del proyecto van por la interfaz real del navegador.
 */

export interface VoyagerResponse {
  ok: boolean;
  status: number;
  url: string;
  body: unknown;
}

function buildUrl(pathOrUrl: string, params?: Record<string, string | number | undefined>): string {
  const base = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${LINKEDIN.voyager}/${pathOrUrl.replace(/^\/+/, "")}`;
  if (!params) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function headers(extra?: Record<string, string>): Promise<Record<string, string>> {
  return {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "csrf-token": await getCsrfToken(),
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "es_ES",
    "x-li-track": JSON.stringify({
      clientVersion: "1.13.0",
      osName: "web",
      timezoneOffset: -5,
      deviceFormFactor: "DESKTOP",
    }),
    referer: LINKEDIN.feed,
    ...extra,
  };
}

async function parse(res: {
  status(): number;
  url(): string;
  text(): Promise<string>;
}): Promise<VoyagerResponse> {
  const status = res.status();
  const raw = await res.text().catch(() => "");
  let body: unknown = raw;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw.slice(0, 4000);
    }
  }
  return { ok: status >= 200 && status < 300, status, url: res.url(), body };
}

export async function voyagerGet(
  path: string,
  params?: Record<string, string | number | undefined>,
  extraHeaders?: Record<string, string>,
): Promise<VoyagerResponse> {
  const ctx = await getContext();
  const url = buildUrl(path, params);
  const res = await ctx.request.get(url, {
    headers: await headers(extraHeaders),
    timeout: 30_000,
  });
  const parsed = await parse(res);
  if (!parsed.ok) log.warn("voyager GET falló", { url, status: parsed.status });
  return parsed;
}

export async function voyagerPost(
  path: string,
  body?: unknown,
  params?: Record<string, string | number | undefined>,
): Promise<VoyagerResponse> {
  const ctx = await getContext();
  const url = buildUrl(path, params);
  const res = await ctx.request.post(url, {
    headers: await headers({ "content-type": "application/json; charset=UTF-8" }),
    ...(body === undefined ? {} : { data: body }),
    timeout: 30_000,
  });
  return parse(res);
}

export async function voyagerRequest(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
  params?: Record<string, string | number | undefined>,
): Promise<VoyagerResponse> {
  const ctx = await getContext();
  const url = buildUrl(path, params);
  const res = await ctx.request.fetch(url, {
    method,
    headers: await headers(
      body === undefined ? {} : { "content-type": "application/json; charset=UTF-8" },
    ),
    ...(body === undefined ? {} : { data: body }),
    timeout: 30_000,
  });
  return parse(res);
}

/* ------------------------------------------------------------------ */
/* Atajos de lectura                                                   */
/* ------------------------------------------------------------------ */

export interface MeInfo {
  memberId?: string;
  vanityUrl?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
}

interface MiniProfile {
  entityUrn?: string;
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  occupation?: string;
}

/**
 * Datos de la cuenta actual.
 *
 * Se pide JSON clásico a propósito: con el `accept` normalizado que usa el
 * resto del cliente, la respuesta llega como `{data, included}` y el perfil
 * queda enterrado. Aun así se contemplan las dos formas, porque LinkedIn
 * cambia cuál devuelve sin avisar.
 */
export async function getMe(): Promise<MeInfo> {
  const res = await voyagerGet("me", undefined, { accept: "application/json" });
  if (!res.ok || !res.body || typeof res.body !== "object") return {};

  const body = res.body as {
    miniProfile?: MiniProfile;
    included?: MiniProfile[];
    data?: { miniProfile?: MiniProfile };
  };

  const mini =
    body.miniProfile ??
    body.data?.miniProfile ??
    body.included?.find((e) => !!e.publicIdentifier);

  if (!mini) return {};

  const memberId = mini.entityUrn?.split(":").pop();
  return {
    ...(memberId ? { memberId } : {}),
    ...(mini.publicIdentifier ? { vanityUrl: mini.publicIdentifier } : {}),
    ...(mini.firstName ? { firstName: mini.firstName } : {}),
    ...(mini.lastName ? { lastName: mini.lastName } : {}),
    ...(mini.occupation ? { headline: mini.occupation } : {}),
  };
}

/** URN del perfil propio, necesario para varias llamadas de escritura. */
export async function getOwnProfileUrn(): Promise<string | undefined> {
  const res = await voyagerGet("identity/dash/profiles", {
    q: "memberIdentity",
    memberIdentity: (await getMe()).vanityUrl ?? "me",
  });
  if (!res.ok) return undefined;
  const body = res.body as { elements?: { entityUrn?: string }[]; included?: { entityUrn?: string }[] };
  const first = body.elements?.[0]?.entityUrn ?? body.included?.[0]?.entityUrn;
  return first;
}
