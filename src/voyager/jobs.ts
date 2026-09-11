import { voyagerGet } from "./client.js";

/**
 * Detalle de una oferta por la API interna.
 *
 * La página de empleo también se renderiza con SDUI (sin `<h1>`, con
 * contenedores tipo `JobDetails_AboutTheJob_<id>`), así que raspar el título y
 * la descripción es frágil. Este endpoint los devuelve completos, e incluye
 * algo que el HTML no dice con claridad: si la oferta admite Solicitud
 * sencilla o manda al sitio de la empresa.
 */

const DECORATION =
  "com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65";

export interface VoyagerJob {
  jobId: string;
  title: string;
  company: string;
  companyUrl?: string;
  location: string;
  remoteAllowed?: boolean;
  applicants?: number;
  postedAt?: string;
  easyApply: boolean;
  easyApplyUrl?: string;
  externalApplyUrl?: string;
  description: string;
  alreadyApplied?: boolean;
  saved?: boolean;
}

interface Included {
  $type?: string;
  name?: string;
  universalName?: string;
  applied?: boolean;
  saved?: boolean;
}

export async function readJobViaVoyager(jobId: string): Promise<VoyagerJob | undefined> {
  const res = await voyagerGet(`jobs/jobPostings/${jobId}`, { decorationId: DECORATION });
  if (!res.ok || !res.body || typeof res.body !== "object") return undefined;

  const body = res.body as { data?: Record<string, unknown>; included?: Included[] };
  const data = body.data;
  if (!data) return undefined;

  const included = body.included ?? [];
  const company = included.find((e) => /organization\.Company$/.test(e.$type ?? ""));
  const applyingInfo = included.find((e) => /JobApplyingInfo$/.test(e.$type ?? ""));
  const savingInfo = included.find((e) => /JobSavingInfo$/.test(e.$type ?? ""));

  const applyMethod = (data["applyMethod"] ?? {}) as {
    easyApplyUrl?: string;
    companyApplyUrl?: string;
  };

  const description = ((data["description"] ?? {}) as { text?: string }).text ?? "";
  const listedAt = data["listedAt"] ?? data["originalListedAt"];

  return {
    jobId,
    title: String(data["title"] ?? ""),
    company: company?.name ?? "",
    ...(company?.universalName
      ? { companyUrl: `https://www.linkedin.com/company/${company.universalName}/` }
      : {}),
    location: String(data["formattedLocation"] ?? ""),
    ...(typeof data["workRemoteAllowed"] === "boolean"
      ? { remoteAllowed: data["workRemoteAllowed"] }
      : {}),
    ...(typeof data["applies"] === "number" ? { applicants: data["applies"] } : {}),
    ...(typeof listedAt === "number" ? { postedAt: new Date(listedAt).toISOString() } : {}),
    easyApply: !!applyMethod.easyApplyUrl,
    ...(applyMethod.easyApplyUrl ? { easyApplyUrl: applyMethod.easyApplyUrl } : {}),
    ...(applyMethod.companyApplyUrl ? { externalApplyUrl: applyMethod.companyApplyUrl } : {}),
    description,
    ...(applyingInfo?.applied !== undefined ? { alreadyApplied: applyingInfo.applied } : {}),
    ...(savingInfo?.saved !== undefined ? { saved: savingInfo.saved } : {}),
  };
}
