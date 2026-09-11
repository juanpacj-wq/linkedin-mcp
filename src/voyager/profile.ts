import { voyagerGet } from "./client.js";
import { log } from "../logger.js";

/**
 * Lectura del perfil por la API interna.
 *
 * LinkedIn migró el perfil a renderizado SDUI: ya no hay `<h1>`, ni anclas
 * `#experience`, y las clases CSS son hashes que cambian solos. Raspar ese HTML
 * es frágil y además carga de forma diferida. Esta ruta pide el perfil completo
 * con todas sus entidades en una sola llamada y lo devuelve estructurado.
 */

interface DateParts {
  month?: number;
  year?: number;
}

interface DateRange {
  start?: DateParts;
  end?: DateParts;
}

interface Entity {
  $type?: string;
  entityUrn?: string;
  [key: string]: unknown;
}

export interface VoyagerProfile {
  url: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  location?: string;
  about?: string;
  email?: string;
  industry?: string;
  vanityUrl?: string;
  openToWork?: boolean;
  experience: {
    title?: string;
    company?: string;
    dates?: string;
    location?: string;
    employmentType?: string;
    description?: string;
  }[];
  education: { school?: string; degree?: string; fieldOfStudy?: string; dates?: string }[];
  skills: string[];
  certifications: { name?: string; issuer?: string; date?: string; url?: string }[];
  languages: { name?: string; level?: string }[];
  projects: { name?: string; dates?: string; description?: string }[];
}

function formatDate(d?: DateParts): string {
  if (!d?.year) return "";
  return d.month ? `${String(d.month).padStart(2, "0")}/${d.year}` : String(d.year);
}

function formatRange(r?: DateRange): string {
  if (!r) return "";
  const start = formatDate(r.start);
  const end = formatDate(r.end);
  if (!start && !end) return "";
  return `${start || "?"} – ${end || "Actualidad"}`;
}

/** Prefiere el texto plano; si solo hay versiones por idioma, toma la primera. */
function localized(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const first = Object.values(value as Record<string, unknown>).find(
      (v) => typeof v === "string" && v.trim() !== "",
    );
    if (typeof first === "string") return first;
  }
  return "";
}

function str(entity: Entity, ...keys: string[]): string {
  for (const key of keys) {
    const direct = entity[key];
    if (typeof direct === "string" && direct.trim()) return direct;
    const multi = entity[`multiLocale${key.charAt(0).toUpperCase()}${key.slice(1)}`];
    const fromMulti = localized(multi);
    if (fromMulti) return fromMulti;
  }
  return "";
}

const TYPE = (name: string) => `com.linkedin.voyager.dash.identity.profile.${name}`;

export async function readProfileViaVoyager(vanity: string): Promise<VoyagerProfile | undefined> {
  const res = await voyagerGet(
    `identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}` +
      `&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101`,
  );

  if (!res.ok) {
    log.warn("perfil por Voyager no disponible", { status: res.status, vanity });
    return undefined;
  }

  const included = ((res.body as { included?: Entity[] } | undefined)?.included ?? []).filter(
    (e): e is Entity => !!e && typeof e === "object",
  );
  if (included.length === 0) return undefined;

  const byUrn = new Map<string, Entity>();
  for (const e of included) if (e.entityUrn) byUrn.set(e.entityUrn, e);

  /**
   * Resuelve una referencia `*campo` o `campoUrn` a la entidad apuntada.
   * Con `container` busca la referencia dentro de un objeto anidado: la
   * ubicación, por ejemplo, vive en `geoLocation["*geo"]`, no suelta.
   */
  const deref = (entity: Entity, field: string, container?: string): Entity | undefined => {
    const source = container ? (entity[container] as Entity | undefined) : entity;
    if (!source || typeof source !== "object") return undefined;
    const ref = source[`*${field}`] ?? source[`${field}Urn`];
    return typeof ref === "string" ? byUrn.get(ref) : undefined;
  };

  const ofType = (name: string): Entity[] => included.filter((e) => e.$type === TYPE(name));

  const profile = included.find((e) => e.$type === TYPE("Profile"));
  if (!profile) return undefined;

  const firstName = str(profile, "firstName");
  const lastName = str(profile, "lastName");

  const geo =
    deref(profile, "geo", "geoLocation") ?? deref(profile, "geoLocation") ?? deref(profile, "geo");
  const location =
    str(profile, "geoLocationName", "locationName") ||
    (geo ? str(geo, "defaultLocalizedName", "name") : "");

  const industryEntity = deref(profile, "industry") ?? deref(profile, "industryV2");
  const emailRaw = profile["emailAddress"];
  const email =
    emailRaw && typeof emailRaw === "object"
      ? String((emailRaw as { emailAddress?: string }).emailAddress ?? "")
      : "";

  const experience = ofType("Position").map((p) => {
    const employmentType = deref(p, "employmentType");
    return {
      title: str(p, "title"),
      company: str(p, "companyName"),
      dates: formatRange(p["dateRange"] as DateRange | undefined),
      location: str(p, "locationName", "geoLocationName"),
      ...(employmentType ? { employmentType: str(employmentType, "name") } : {}),
      description: str(p, "description"),
    };
  });

  const education = ofType("Education").map((e) => ({
    school: str(e, "schoolName"),
    degree: str(e, "degreeName"),
    fieldOfStudy: str(e, "fieldOfStudy"),
    dates: formatRange(e["dateRange"] as DateRange | undefined),
  }));

  const skills = ofType("Skill")
    .map((s) => str(s, "name"))
    .filter(Boolean);

  const certifications = ofType("Certification").map((c) => ({
    name: str(c, "name"),
    issuer: str(c, "authority"),
    date: formatRange(c["dateRange"] as DateRange | undefined),
    url: str(c, "url"),
  }));

  const languages = ofType("Language").map((l) => ({
    name: str(l, "name"),
    level: str(l, "proficiency"),
  }));

  const projects = ofType("Project").map((p) => ({
    name: str(p, "title", "name"),
    dates: formatRange(p["dateRange"] as DateRange | undefined),
    description: str(p, "description"),
  }));

  const publicIdentifier = str(profile, "publicIdentifier") || vanity;

  return {
    url: `https://www.linkedin.com/in/${publicIdentifier}/`,
    name: [firstName, lastName].filter(Boolean).join(" "),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    headline: str(profile, "headline"),
    ...(location ? { location } : {}),
    about: str(profile, "summary"),
    ...(email ? { email } : {}),
    ...(industryEntity ? { industry: str(industryEntity, "name") } : {}),
    vanityUrl: publicIdentifier,
    openToWork: profile["openToWork"] === true,
    experience,
    education,
    skills,
    certifications,
    languages,
    projects,
  };
}
