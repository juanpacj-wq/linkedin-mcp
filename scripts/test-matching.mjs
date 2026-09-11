/**
 * Pruebas de la lógica de emparejado de etiquetas. Es la pieza de la que
 * depende todo: si falla, el perfil se rellena en el campo equivocado y las
 * postulaciones se atascan. No necesita navegador ni sesión.
 */
import { matchField, matchOption } from "../dist/browser/forms.js";
import { normalizeLabel, bestScore } from "../dist/text.js";
import { lookupAnswer } from "../dist/state/store.js";

let failures = 0;
function check(label, cond, extra = "") {
  console.log(`${cond ? "OK  " : "FALLA"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const field = (label, kind = "text", options) => ({
  ref: label,
  label,
  kind,
  required: false,
  disabled: false,
  value: "",
  ...(options ? { options } : {}),
});

console.log("== Normalización ==");
check("quita tildes", normalizeLabel("Años de Experiencia") === "anos de experiencia");
check("colapsa espacios y signos", normalizeLabel("  Teléfono:  móvil * ") === "telefono movil");
check("cadena vacía es segura", normalizeLabel("") === "");

console.log("\n== Emparejado de campos, mismo idioma ==");
const esFields = [
  field("Titular"),
  field("Cargo"),
  field("Empresa"),
  field("Fecha de inicio"),
  field("Fecha de finalización"),
  field("Descripción", "textarea"),
];
check("exacto", matchField(esFields, "Titular")?.label === "Titular");
check("insensible a mayúsculas y tildes", matchField(esFields, "descripcion")?.label === "Descripción");
check(
  "distingue inicio de finalización",
  matchField(esFields, "Fecha de finalización")?.label === "Fecha de finalización",
);
check(
  "distingue finalización de inicio",
  matchField(esFields, "Fecha de inicio")?.label === "Fecha de inicio",
);
check("etiqueta inexistente devuelve undefined", matchField(esFields, "Color favorito") === undefined);

console.log("\n== Emparejado bilingüe (LinkedIn puede estar en inglés) ==");
const enFields = [
  field("Headline"),
  field("Title"),
  field("Company or organization"),
  field("Start date"),
  field("End date"),
  field("Description", "textarea"),
  field("Location"),
  field("Industry", "select", ["Information Technology", "Banking"]),
];
check("Titular → Headline", matchField(enFields, "Titular")?.label === "Headline");
check("Cargo → Title", matchField(enFields, "Cargo")?.label === "Title");
check("Empresa → Company", matchField(enFields, "Empresa")?.label === "Company or organization");
check("Descripción → Description", matchField(enFields, "Descripción")?.label === "Description");
check("Ubicación → Location", matchField(enFields, "Ubicación")?.label === "Location");
check("Sector → Industry", matchField(enFields, "Sector")?.label === "Industry");
check(
  "Fecha de inicio → Start date",
  matchField(enFields, "Fecha de inicio")?.label === "Start date",
);
check("Fecha de fin → End date", matchField(enFields, "Fecha de finalización")?.label === "End date");

console.log("\n== Y al revés: pedir en inglés sobre interfaz en español ==");
check("Headline → Titular", matchField(esFields, "Headline")?.label === "Titular");
check("Company → Empresa", matchField(esFields, "Company")?.label === "Empresa");

console.log("\n== Un campo no se asigna dos veces ==");
const ambiguous = [field("Nombre"), field("Nombre de la empresa")];
const m1 = matchField(ambiguous, "Nombre de la empresa");
check("prefiere la coincidencia más específica", m1?.label === "Nombre de la empresa", m1?.label);

console.log("\n== Opciones de listas cerradas ==");
const yesNo = ["Yes", "No"];
check("sí → Yes", matchOption(yesNo, "sí") === "Yes");
check("si → Yes", matchOption(yesNo, "si") === "Yes");
check("true → Yes", matchOption(yesNo, "true") === "Yes");
check("no → No", matchOption(yesNo, "no") === "No");
const siNo = ["Sí", "No"];
check("yes → Sí", matchOption(siNo, "yes") === "Sí");
const levels = ["Principiante", "Intermedio", "Avanzado", "Nativo o bilingüe"];
check("coincidencia exacta en lista", matchOption(levels, "Avanzado") === "Avanzado");
check("coincidencia parcial", matchOption(levels, "Nativo") === "Nativo o bilingüe");
check("opción inexistente devuelve undefined", matchOption(levels, "Experto absoluto") === undefined);

console.log("\n== Banco de respuestas reutiliza entre redacciones ==");
const bank = {
  profile: {},
  answers: {
    "anos de experiencia en python": "5",
    "estas autorizado para trabajar en colombia": "Sí",
    "pretension salarial": "8000000",
  },
};
check(
  "misma pregunta, otra redacción",
  lookupAnswer("¿Cuántos años de experiencia en Python tienes?", bank) === "5",
  String(lookupAnswer("¿Cuántos años de experiencia en Python tienes?", bank)),
);
check(
  "coincidencia exacta normalizada",
  lookupAnswer("Pretensión salarial", bank) === "8000000",
);
check(
  "pregunta no relacionada no inventa respuesta",
  lookupAnswer("¿Tienes licencia de conducción?", bank) === undefined,
  String(lookupAnswer("¿Tienes licencia de conducción?", bank)),
);

console.log("\n== Puntuación ==");
check("idénticas puntúan 1", bestScore("Titular", "Titular") === 1);
check("equivalentes puntúan 1", bestScore("Titular", "Headline") === 1);
check("no relacionadas puntúan bajo", bestScore("Titular", "Color favorito") < 0.5);

console.log("");
console.log(
  failures === 0
    ? "LÓGICA DE EMPAREJADO VALIDADA."
    : `${failures} comprobación(es) fallaron.`,
);
process.exit(failures === 0 ? 0 : 1);
