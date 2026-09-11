import type { Page } from "playwright";
import { LINKEDIN } from "../config.js";
import { getPage, ensureLoggedIn, screenshot } from "../browser/session.js";
import {
  clickButton,
  defaultScope,
  describeForm,
  fillField,
  type FieldDescriptor,
  type FormSnapshot,
} from "../browser/forms.js";
import { pause, humanScroll, retry } from "../browser/humanize.js";
import { guardOutbound, commitOutbound } from "./guard.js";
import {
  lookupAnswer,
  rememberAnswer,
  readAnswerBank,
  recordApplication,
  hasApplied,
  resolveDocument,
  type ApplicationRecord,
} from "../state/store.js";
import { log } from "../logger.js";
import { bestScore } from "../text.js";
import { readJobViaVoyager } from "../voyager/jobs.js";

/* ------------------------------------------------------------------ */
/* Búsqueda                                                            */
/* ------------------------------------------------------------------ */

export interface JobSearchOptions {
  keywords: string;
  location?: string;
  /** Solo ofertas con "Solicitud sencilla". */
  easyApplyOnly?: boolean;
  datePosted?: "day" | "week" | "month" | "any";
  experienceLevel?: ("internship" | "entry" | "associate" | "mid-senior" | "director" | "executive")[];
  workplace?: ("on-site" | "remote" | "hybrid")[];
  jobType?: ("full-time" | "part-time" | "contract" | "temporary" | "internship")[];
  sortBy?: "date" | "relevance";
  limit?: number;
  /** Desplazamiento para paginar (0, 25, 50...). */
  start?: number;
}

export interface JobResult {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  posted?: string;
  easyApply: boolean;
  alreadyApplied: boolean;
  promoted?: boolean;
}

const EXPERIENCE_CODES: Record<string, string> = {
  internship: "1",
  entry: "2",
  associate: "3",
  "mid-senior": "4",
  director: "5",
  executive: "6",
};

const WORKPLACE_CODES: Record<string, string> = {
  "on-site": "1",
  remote: "2",
  hybrid: "3",
};

const JOBTYPE_CODES: Record<string, string> = {
  "full-time": "F",
  "part-time": "P",
  contract: "C",
  temporary: "T",
  internship: "I",
};

const DATE_CODES: Record<string, string> = {
  day: "r86400",
  week: "r604800",
  month: "r2592000",
};

export function buildJobSearchUrl(opts: JobSearchOptions): string {
  const url = new URL(`${LINKEDIN.base}/jobs/search/`);
  url.searchParams.set("keywords", opts.keywords);
  if (opts.location) url.searchParams.set("location", opts.location);
  if (opts.easyApplyOnly) url.searchParams.set("f_AL", "true");
  if (opts.datePosted && opts.datePosted !== "any") {
    const code = DATE_CODES[opts.datePosted];
    if (code) url.searchParams.set("f_TPR", code);
  }
  if (opts.experienceLevel?.length) {
    url.searchParams.set(
      "f_E",
      opts.experienceLevel.map((e) => EXPERIENCE_CODES[e]).filter(Boolean).join(","),
    );
  }
  if (opts.workplace?.length) {
    url.searchParams.set(
      "f_WT",
      opts.workplace.map((w) => WORKPLACE_CODES[w]).filter(Boolean).join(","),
    );
  }
  if (opts.jobType?.length) {
    url.searchParams.set(
      "f_JT",
      opts.jobType.map((j) => JOBTYPE_CODES[j]).filter(Boolean).join(","),
    );
  }
  url.searchParams.set("sortBy", opts.sortBy === "relevance" ? "R" : "DD");
  if (opts.start) url.searchParams.set("start", String(opts.start));
  return url.toString();
}

export async function searchJobs(opts: JobSearchOptions): Promise<JobResult[]> {
  await ensureLoggedIn();
  const page = await getPage();
  const url = buildJobSearchUrl(opts);

  await retry(() => page.goto(url, { waitUntil: "domcontentloaded" }), { label: "buscar empleos" });
  await pause(page, 2_000, 3_200);
  await humanScroll(page, 6);

  const raw = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const cards = Array.from(
      document.querySelectorAll(
        "li[data-occludable-job-id], div.job-card-container, li.jobs-search-results__list-item",
      ),
    );

    return cards
      .map((card) => {
        const idAttr =
          card.getAttribute("data-occludable-job-id") ??
          card.querySelector("[data-job-id]")?.getAttribute("data-job-id") ??
          "";
        const link = card.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]');
        const href = link?.href ?? "";
        const idFromHref = href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1] ?? "";
        const jobId = idAttr || idFromHref;
        if (!jobId) return null;

        // La tarjeta repite el título para lectores de pantalla, así que el
        // texto del enlace viene duplicado. Los <span> deduplicados dan, en
        // orden: título, empresa, ubicación.
        const spans = Array.from(card.querySelectorAll("span"))
          .map((s) => clean(s.textContent))
          .filter(Boolean);
        const unique: string[] = [];
        for (const s of spans) if (!unique.includes(s)) unique.push(s);

        const ruido = /solicitud sencilla|easy apply|promocionad|promoted|antiguos alumnos|alumni|verification|con verificación|hace \d|ago|solicitud enviada|applied|visto|viewed/i;
        const utiles = unique.filter((u) => !ruido.test(u) && u.length > 1);

        const lockup = (suffix: string) =>
          clean(card.querySelector(`.artdeco-entity-lockup__${suffix}`)?.textContent);

        const tituloStrong = clean(card.querySelector("strong")?.textContent);
        const title = tituloStrong || lockup("title") || (utiles[0] ?? "");
        const company = lockup("subtitle") || (utiles.find((u) => u !== title) ?? "");
        const location =
          lockup("caption") || (utiles.find((u) => u !== title && u !== company) ?? "");

        const text = clean(card.textContent);

        return {
          jobId,
          title,
          company,
          location,
          url: `https://www.linkedin.com/jobs/view/${jobId}/`,
          easyApply: /solicitud sencilla|easy apply/i.test(text),
          promoted: /promocionad|promoted/i.test(text),
          posted: text.match(/hace\s+[^·]+|\d+\s+(day|hour|week|month)s?\s+ago/i)?.[0] ?? "",
          appliedBadge: /solicitud enviada|applied/i.test(text),
        };
      })
      .filter((j): j is NonNullable<typeof j> => j !== null);
  });

  const seen = new Set<string>();
  const results: JobResult[] = [];
  for (const job of raw) {
    if (seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    results.push({
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      ...(job.posted ? { posted: job.posted } : {}),
      easyApply: job.easyApply,
      alreadyApplied: job.appliedBadge || hasApplied(job.jobId) !== undefined,
      ...(job.promoted ? { promoted: true } : {}),
    });
    if (results.length >= (opts.limit ?? 25)) break;
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Detalle de una oferta                                               */
/* ------------------------------------------------------------------ */

export interface JobDetail {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  workplaceType?: string;
  applicants?: string;
  posted?: string;
  easyApply: boolean;
  externalApplyUrl?: string;
  description: string;
  alreadyApplied: boolean;
}

export function jobUrl(jobId: string): string {
  return `${LINKEDIN.base}/jobs/view/${jobId}/`;
}

export function extractJobId(input: string): string {
  const fromUrl = input.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1];
  if (fromUrl) return fromUrl;
  const fromParam = input.match(/currentJobId=(\d+)/)?.[1];
  if (fromParam) return fromParam;
  const digits = input.match(/^\d+$/)?.[0];
  if (digits) return digits;
  throw new Error(`No se pudo extraer el id de la oferta de: "${input}"`);
}

export async function getJobDetail(jobIdOrUrl: string): Promise<JobDetail> {
  await ensureLoggedIn();
  const jobId = extractJobId(jobIdOrUrl);

  // Vía principal: la API interna. Devuelve título, descripción completa y,
  // sobre todo, si la oferta admite Solicitud sencilla — algo que el HTML
  // renderizado con SDUI ya no dice de forma fiable.
  try {
    const viaApi = await readJobViaVoyager(jobId);
    if (viaApi && viaApi.title) {
      return {
        jobId,
        url: jobUrl(jobId),
        title: viaApi.title,
        company: viaApi.company,
        location: viaApi.location,
        ...(viaApi.remoteAllowed ? { workplaceType: "En remoto" } : {}),
        ...(viaApi.applicants !== undefined
          ? { applicants: `${viaApi.applicants} solicitudes` }
          : {}),
        ...(viaApi.postedAt ? { posted: viaApi.postedAt } : {}),
        easyApply: viaApi.easyApply,
        ...(viaApi.externalApplyUrl ? { externalApplyUrl: viaApi.externalApplyUrl } : {}),
        description: viaApi.description,
        alreadyApplied: viaApi.alreadyApplied === true || hasApplied(jobId) !== undefined,
      };
    }
  } catch (err) {
    log.warn("detalle de oferta por API falló, se raspa el HTML", String(err));
  }

  const page = await getPage();
  await retry(() => page.goto(jobUrl(jobId), { waitUntil: "domcontentloaded" }), {
    label: "abrir oferta",
  });
  await pause(page, 2_500, 3_800);
  await clickButton(page, /ver más|mostrar más|see more|show more/i, "main").catch(() => undefined);
  await pause(page, 600, 1_200);

  const detail = await page.evaluate((id: string) => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const bodyText = document.body.innerText;

    // Los contenedores nuevos llevan el id de la oferta en su propio id.
    const about = document.getElementById(`JobDetails_AboutTheJob_${id}`);
    const description = clean(
      about?.textContent ??
        document.querySelector("#job-details, .jobs-description__content, .jobs-box__html-content")
          ?.textContent,
    ).slice(0, 20000);

    const companyLink = document.querySelector<HTMLAnchorElement>("a[href*='/company/']");
    const company = clean(companyLink?.textContent);

    const buttons = Array.from(document.querySelectorAll("button, a")).map((b) =>
      clean(b.getAttribute("aria-label") ?? b.textContent),
    );

    return {
      title: clean(document.querySelector("h1")?.textContent),
      company,
      description,
      easyApply: buttons.some((b) => /solicitud sencilla|easy apply/i.test(b)),
      applicants: bodyText.match(/([\d.,]+)\s*(solicitudes|solicitantes|applicants)/i)?.[0] ?? "",
      posted: bodyText.match(/hace\s+[\w\s]+|\d+\s+(day|hour|week|month)s?\s+ago/i)?.[0] ?? "",
      alreadyApplied: /solicitud enviada|applied on|ya te postulaste/i.test(bodyText),
    };
  }, jobId);

  return {
    jobId,
    url: jobUrl(jobId),
    title: detail.title,
    company: detail.company,
    location: "",
    ...(detail.applicants ? { applicants: detail.applicants } : {}),
    ...(detail.posted ? { posted: detail.posted } : {}),
    easyApply: detail.easyApply,
    description: detail.description,
    alreadyApplied: detail.alreadyApplied || hasApplied(jobId) !== undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Solicitud sencilla (Easy Apply)                                     */
/* ------------------------------------------------------------------ */

export interface ApplyOptions {
  /** Respuestas explícitas para esta oferta: etiqueta → valor. */
  answers?: Record<string, string>;
  /** CV a adjuntar. Si se omite se usa el del banco o el que LinkedIn traiga. */
  resumePath?: string;
  /** Recorre el formulario y reporta, pero NO envía. Es el valor por defecto. */
  dryRun?: boolean;
  /** Obligatorio para enviar de verdad. */
  confirm?: boolean;
  /** Marcar "seguir a la empresa". Por defecto no. */
  followCompany?: boolean;
  /** Guarda las respuestas nuevas en el banco para futuras ofertas. */
  rememberAnswers?: boolean;
  maxSteps?: number;
}

export interface ApplyStepReport {
  step: number;
  title?: string;
  progress?: string;
  filled: { label: string; value: string; source: "explícita" | "banco" | "cv" }[];
  unanswered: { label: string; kind: string; required: boolean; options?: string[]; hint?: string }[];
  errors: string[];
}

export interface ApplyResult {
  jobId: string;
  url: string;
  title: string;
  company: string;
  status: "applied" | "dry-run" | "needs-answers" | "external" | "already-applied" | "failed";
  detail: string;
  steps: ApplyStepReport[];
  /** Preguntas que hay que responder para poder terminar. */
  pendingQuestions: { label: string; kind: string; options?: string[]; hint?: string }[];
  screenshot?: string;
}

const NEXT_LABELS = /^(siguiente|next|continuar|continue)$/i;
const REVIEW_LABELS = /^(revisar|review|revisar solicitud)$/i;
const SUBMIT_LABELS = /^(enviar solicitud|enviar|submit application|submit)$/i;

function isAnswered(field: FieldDescriptor): boolean {
  if (field.kind === "checkbox") return true; // opcional salvo que sea obligatorio marcado
  return field.value.trim() !== "";
}

/** Decide con qué valor rellenar un campo, y de dónde sale. */
function decideValue(
  field: FieldDescriptor,
  explicit: Record<string, string>,
  resume: string | undefined,
): { value: string; source: "explícita" | "banco" | "cv" } | undefined {
  // 1. Respuesta explícita para esta oferta: gana la etiqueta más parecida,
  //    no la primera que se parezca un poco.
  let bestExplicit: { value: string; score: number } | undefined;
  for (const [label, value] of Object.entries(explicit)) {
    const score = bestScore(label, field.label);
    if (score >= 0.6 && (!bestExplicit || score > bestExplicit.score)) {
      bestExplicit = { value, score };
    }
  }
  if (bestExplicit) return { value: bestExplicit.value, source: "explícita" };

  // 2. CV para campos de archivo.
  if (field.kind === "file" && resume) {
    return { value: resume, source: "cv" };
  }

  // 3. Banco de respuestas aprendidas.
  const remembered = lookupAnswer(field.label);
  if (remembered !== undefined) return { value: remembered, source: "banco" };

  return undefined;
}

async function closeApplyModal(page: Page): Promise<void> {
  await clickButton(page, /^(descartar|cerrar|dismiss|close)$/i, "body").catch(() => undefined);
  await pause(page, 700, 1_400);
  // LinkedIn pregunta si guardar el borrador.
  await clickButton(page, /^(descartar|discard)$/i, "body").catch(() => undefined);
  await pause(page, 700, 1_400);
  await page.keyboard.press("Escape").catch(() => undefined);
}

export async function applyToJob(
  jobIdOrUrl: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Simula salvo que se pida explícitamente lo contrario. Enviar de verdad
  // exige las dos cosas a la vez: dryRun:false y confirm:true.
  const dryRun = options.dryRun ?? true;
  if (!dryRun) {
    guardOutbound("applications", options.confirm, `postular a la oferta ${jobIdOrUrl}`);
  }

  const jobId = extractJobId(jobIdOrUrl);
  const detail = await getJobDetail(jobId);
  const page = await getPage();

  const baseResult = {
    jobId,
    url: detail.url,
    title: detail.title,
    company: detail.company,
    steps: [] as ApplyStepReport[],
    pendingQuestions: [] as ApplyResult["pendingQuestions"],
  };

  if (detail.alreadyApplied) {
    return {
      ...baseResult,
      status: "already-applied",
      detail: "Ya hay una solicitud registrada para esta oferta.",
    };
  }

  if (!detail.easyApply) {
    return {
      ...baseResult,
      status: "external",
      detail:
        "Esta oferta no usa Solicitud sencilla: se postula en el sitio de la empresa" +
        (detail.externalApplyUrl ? ` (${detail.externalApplyUrl})` : "") +
        ". No se puede completar desde LinkedIn.",
    };
  }

  const bank = readAnswerBank();
  const resume =
    (options.resumePath ? resolveDocument(options.resumePath) : undefined) ??
    (bank.defaultResume ? resolveDocument(bank.defaultResume) : undefined);

  const explicit = { ...bank.profile, ...(options.answers ?? {}) };

  // El detalle viene de la API, que no navega: hay que abrir la oferta antes
  // de buscar el botón de Solicitud sencilla.
  if (!page.url().includes(`/jobs/view/${jobId}`)) {
    await retry(() => page.goto(jobUrl(jobId), { waitUntil: "domcontentloaded" }), {
      label: "abrir la oferta para postular",
    });
    await pause(page, 2_500, 3_800);
  }

  const opened = await clickButton(page, /solicitud sencilla|easy apply/i, "main");
  if (!opened) {
    const shot = await screenshot(`apply-${jobId}-sin-boton`);
    return {
      ...baseResult,
      status: "failed",
      detail: "No se pudo abrir el formulario de Solicitud sencilla.",
      screenshot: shot,
    };
  }
  await pause(page, 1_500, 2_800);

  const maxSteps = options.maxSteps ?? 12;
  const answeredThisRun: Record<string, string> = {};

  for (let step = 1; step <= maxSteps; step++) {
    const scope = await defaultScope(page);
    const snapshot: FormSnapshot = await describeForm(page, scope);
    const report: ApplyStepReport = {
      step,
      ...(snapshot.title ? { title: snapshot.title } : {}),
      ...(snapshot.progress ? { progress: snapshot.progress } : {}),
      filled: [],
      unanswered: [],
      errors: snapshot.errors,
    };

    for (const field of snapshot.fields) {
      if (field.disabled) continue;

      // "Seguir a la empresa" viene marcado por defecto: se respeta la preferencia.
      if (field.kind === "checkbox" && /seguir|follow/i.test(field.label)) {
        const want = options.followCompany === true;
        const isOn = field.value === "true";
        if (want !== isOn) await fillField(page, field, want ? "true" : "false");
        continue;
      }

      if (isAnswered(field) && field.kind !== "file") continue;

      const decision = decideValue(field, explicit, resume);
      if (!decision) {
        if (field.required) {
          report.unanswered.push({
            label: field.label,
            kind: field.kind,
            required: true,
            ...(field.options ? { options: field.options } : {}),
            ...(field.hint ? { hint: field.hint } : {}),
          });
        }
        continue;
      }

      if (field.kind === "file" && !decision.value) continue;

      const result = await fillField(page, field, decision.value);
      if (result.status === "filled") {
        report.filled.push({
          label: field.label,
          value: decision.source === "cv" ? decision.value : decision.value.slice(0, 120),
          source: decision.source,
        });
        if (decision.source === "explícita" && field.kind !== "file") {
          answeredThisRun[field.label] = decision.value;
        }
      } else {
        report.unanswered.push({
          label: field.label,
          kind: field.kind,
          required: field.required,
          ...(field.options ? { options: field.options } : {}),
          ...(result.detail ? { hint: result.detail } : {}),
        });
      }
    }

    baseResult.steps.push(report);

    // Si quedan obligatorias sin respuesta, se detiene y se pide ayuda.
    if (report.unanswered.some((u) => u.required)) {
      const shot = await screenshot(`apply-${jobId}-paso${step}`);
      await closeApplyModal(page);
      const pending = report.unanswered.filter((u) => u.required);
      recordApplication({
        jobId,
        title: detail.title,
        company: detail.company,
        location: detail.location,
        url: detail.url,
        appliedAt: new Date().toISOString(),
        status: "skipped",
        notes: `Faltan respuestas: ${pending.map((p) => p.label).join(" | ")}`,
      });
      return {
        ...baseResult,
        status: "needs-answers",
        detail:
          `El formulario pide datos que no tengo. Respóndelos y vuelve a llamar la herramienta ` +
          `pasándolos en \`answers\` (se guardarán para las próximas ofertas).`,
        pendingQuestions: pending.map((p) => ({
          label: p.label,
          kind: p.kind,
          ...(p.options ? { options: p.options } : {}),
          ...(p.hint ? { hint: p.hint } : {}),
        })),
        screenshot: shot,
      };
    }

    // Avanzar: enviar > revisar > siguiente.
    const buttons = await describeForm(page, scope).then((s) => s.buttons);
    const hasSubmit = buttons.some((b) => SUBMIT_LABELS.test(b.label) && !b.disabled);

    if (hasSubmit) {
      if (dryRun) {
        const shot = await screenshot(`apply-${jobId}-revision`);
        await closeApplyModal(page);
        recordApplication({
          jobId,
          title: detail.title,
          company: detail.company,
          location: detail.location,
          url: detail.url,
          appliedAt: new Date().toISOString(),
          status: "dry-run",
          notes: "Simulación completada: el formulario se llenó hasta el botón de envío.",
          questionsAnswered: answeredThisRun,
        });
        return {
          ...baseResult,
          status: "dry-run",
          detail:
            "Simulación completa: el formulario quedó listo hasta el paso final y no se envió. " +
            "Para enviar de verdad, vuelve a llamar con `confirm: true` y `dryRun: false`.",
          screenshot: shot,
        };
      }

      const submitted = await clickButton(page, SUBMIT_LABELS, scope);
      await pause(page, 2_500, 4_000);
      if (!submitted) {
        const shot = await screenshot(`apply-${jobId}-sin-enviar`);
        await closeApplyModal(page);
        return {
          ...baseResult,
          status: "failed",
          detail: "No se pudo pulsar Enviar solicitud.",
          screenshot: shot,
        };
      }

      const confirmationText = await page
        .locator(scope)
        .last()
        .innerText()
        .catch(() => "");
      const success = /solicitud enviada|se envió|application sent|applied/i.test(confirmationText);

      const shot = await screenshot(`apply-${jobId}-enviada`);
      await closeApplyModal(page);

      if (options.rememberAnswers !== false) {
        for (const [label, value] of Object.entries(answeredThisRun)) rememberAnswer(label, value);
      }

      const record: ApplicationRecord = {
        jobId,
        title: detail.title,
        company: detail.company,
        location: detail.location,
        url: detail.url,
        appliedAt: new Date().toISOString(),
        status: "applied",
        questionsAnswered: answeredThisRun,
      };
      recordApplication(record);
      commitOutbound("applications", { target: `${detail.title} — ${detail.company}` });
      log.info("solicitud enviada", { jobId, title: detail.title });

      return {
        ...baseResult,
        status: "applied",
        detail: success
          ? `Solicitud enviada a ${detail.company} para "${detail.title}".`
          : `Se pulsó Enviar. LinkedIn no mostró la confirmación esperada; revisa la captura y "Mis empleos".`,
        screenshot: shot,
      };
    }

    const advanced =
      (await clickButton(page, REVIEW_LABELS, scope)) ||
      (await clickButton(page, NEXT_LABELS, scope));

    if (!advanced) {
      const shot = await screenshot(`apply-${jobId}-atascado`);
      await closeApplyModal(page);
      return {
        ...baseResult,
        status: "failed",
        detail:
          "El asistente no avanzó: no se encontró Siguiente, Revisar ni Enviar. " +
          "Revisa la captura; puede haber un campo nuevo sin reconocer.",
        screenshot: shot,
      };
    }

    await pause(page, 1_200, 2_400);
  }

  const shot = await screenshot(`apply-${jobId}-limite`);
  await closeApplyModal(page);
  return {
    ...baseResult,
    status: "failed",
    detail: `Se alcanzó el límite de ${maxSteps} pasos sin llegar al envío.`,
    screenshot: shot,
  };
}

/** Guarda o quita una oferta de favoritos. */
export async function toggleSaveJob(jobIdOrUrl: string, save = true): Promise<{ ok: boolean; detail: string }> {
  await ensureLoggedIn();
  const jobId = extractJobId(jobIdOrUrl);
  const page = await getPage();
  await page.goto(jobUrl(jobId), { waitUntil: "domcontentloaded" });
  await pause(page, 1_800, 3_000);

  const pattern = save ? /^(guardar|save)$/i : /^(guardado|saved|quitar de guardados)$/i;
  const ok = await clickButton(page, pattern, "main");
  await pause(page, 900, 1_800);
  return {
    ok,
    detail: ok
      ? save
        ? "Oferta guardada."
        : "Oferta quitada de guardados."
      : "No se encontró el botón.",
  };
}

/** Lista las ofertas guardadas o las solicitudes enviadas, según LinkedIn. */
export async function myJobs(
  tab: "saved" | "applied" = "applied",
): Promise<{ title: string; company: string; url: string; status?: string }[]> {
  await ensureLoggedIn();
  const page = await getPage();
  const url =
    tab === "saved"
      ? `${LINKEDIN.base}/my-items/saved-jobs/`
      : `${LINKEDIN.base}/my-items/saved-jobs/?cardType=APPLIED`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pause(page, 2_000, 3_200);
  await humanScroll(page, 4);

  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("li"))
      .map((li) => {
        const link = li.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]');
        if (!link) return null;
        const spans = Array.from(li.querySelectorAll('span[aria-hidden="true"]'))
          .map((s) => clean(s.textContent))
          .filter(Boolean);
        const unique: string[] = [];
        for (const s of spans) if (!unique.includes(s)) unique.push(s);
        return {
          title: clean(link.textContent) || (unique[0] ?? ""),
          company: unique[1] ?? "",
          url: link.href.split("?")[0] ?? link.href,
          status: unique.find((u) => /solicitud|applied|visto|viewed/i.test(u)) ?? "",
        };
      })
      .filter((j): j is NonNullable<typeof j> => j !== null);
  });
}
