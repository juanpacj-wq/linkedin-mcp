import { CONFIG, type LimitKey } from "../config.js";
import { assertWithinLimit, recordUsage, recordOutreach, usageToday } from "../state/store.js";

/**
 * Puerta única para toda acción que sale hacia afuera (queda visible para otra
 * persona y no siempre se puede deshacer). Hace tres cosas: exige confirmación
 * explícita, respeta el tope diario y deja rastro de lo hecho.
 */
export function guardOutbound(
  kind: LimitKey,
  confirm: boolean | undefined,
  description: string,
): void {
  if (CONFIG.requireConfirm && confirm !== true) {
    const usage = usageToday()[kind];
    throw new Error(
      `Acción no ejecutada por seguridad: ${description}.\n` +
        `Es una acción visible para terceros, así que exige \`confirm: true\` explícito. ` +
        `Consumo de hoy en "${kind}": ${usage.used}/${usage.limit}.`,
    );
  }
  assertWithinLimit(kind);
}

export function commitOutbound(
  kind: LimitKey,
  record: { target: string; detail?: string },
): void {
  recordUsage(kind);
  const outreachKind: Record<string, "invitation" | "message" | "comment" | "reaction" | "follow" | "post" | "endorsement"> = {
    invitations: "invitation",
    invitationResponses: "invitation",
    endorsements: "endorsement",
    messages: "message",
    comments: "comment",
    reactions: "reaction",
    follows: "follow",
    posts: "post",
  };
  const mapped = outreachKind[kind];
  if (mapped) {
    recordOutreach({
      kind: mapped,
      target: record.target,
      at: new Date().toISOString(),
      ...(record.detail ? { detail: record.detail } : {}),
    });
  }
}
