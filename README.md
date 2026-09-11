# linkedin-pilot

Servidor **MCP** (y CLI) que controla LinkedIn con tu sesión real, en un navegador
persistente. Cubre las tres cosas de punta a punta:

1. **Actualizar tu perfil completo** — titular, acerca de, experiencia, educación,
   aptitudes, certificaciones, proyectos, idiomas, foto, portada, información de
   contacto, URL personalizada y "Abierto a trabajar".
2. **Interactuar con otros perfiles** — buscar personas, invitar a conectar con
   nota, enviar mensajes, seguir, validar aptitudes, gestionar invitaciones,
   reaccionar y comentar publicaciones, publicar en el feed.
3. **Postular a ofertas de empleo** — buscar con todos los filtros de LinkedIn,
   leer el detalle y completar la Solicitud sencilla (Easy Apply) paso a paso.

---

## Por qué está hecho así

**La API oficial no sirve para esto.** Desde 2015 LinkedIn exige entrar al
Partner Program para cualquier acceso real, y ni siquiera los partners tienen
escritura sobre el perfil: la API pública devuelve nombre, titular y correo, y
poco más. SNAP dejó de aceptar solicitudes nuevas. No hay ruta oficial para
"actualiza mi experiencia" ni para "postula a esta oferta".

**Entonces la vía es la interfaz real**, conducida por Playwright con tu propia
sesión.

### Leer y escribir van por caminos distintos

LinkedIn migró el perfil, la oferta de empleo y los resultados de búsqueda a
renderizado **SDUI**: ya no hay `<h1>`, desaparecieron las anclas de sección
(`#experience`, `#about`), las clases CSS son hashes que cambian solos y el
contenido se carga de forma diferida. Raspar ese HTML para *leer* es frágil y
lento.

Por eso el proyecto usa dos vías:

- **Para leer** — la API interna (Voyager), que devuelve el perfil completo y
  el detalle de una oferta en una sola llamada, estructurados. Se aprovecha la
  sesión del propio navegador, así que las peticiones salen con las mismas
  cookies, el mismo user-agent y la misma IP que la navegación real.
- **Para escribir** — la interfaz, porque no hay otra: no existe endpoint para
  guardar tu experiencia ni para postular.

Cuando una vía falla se cae a la otra, y ambas quedan reportadas.

### Tres decisiones sostienen lo demás

- **Sesión persistente, login manual.** El navegador guarda su perfil en disco,
  así que inicias sesión una sola vez —con verificación en dos pasos y captcha
  incluidos— y las cookies sobreviven entre ejecuciones. No se automatiza el
  login a propósito: automatizarlo es justo lo que dispara los bloqueos, y
  además obligaría a guardar tu contraseña en algún lado.

- **Los campos se identifican por su etiqueta visible, no por clases CSS.**
  LinkedIn cambia el HTML constantemente y sirve la interfaz en el idioma de la
  cuenta. El motor de formularios lee el nombre accesible de cada control
  (`aria-label`, `<label for>`, `legend`...) y lo empareja contra un glosario
  bilingüe: pedir `Titular` encuentra `Headline`, y al revés. Esto se ve
  funcionando en las postulaciones reales, donde una pregunta como
  «Confirm the name of the company where you work / Confirme o nome da
  empresa...» se resuelve sola con la respuesta guardada como «Current company».

- **El contenedor del formulario se descubre, no se asume.** Los editores de
  perfil dejaron de ser ventanas modales: ahora son páginas que ni siquiera
  cuelgan de `<main>`, y el asistente de Solicitud sencilla tampoco es un
  `role="dialog"`. En vez de perseguir esa estructura, el motor parte del botón
  que cierra el paso (Guardar, Siguiente, Enviar) y sube hasta el primer
  ancestro que agrupa varios campos. Funcione donde funcione el formulario.

- **Una sola pieza rellena todo.** Editar el perfil y postular a un empleo son
  el mismo problema: un modal con campos. El mismo motor sirve para ambos, así
  que cualquier sección nueva que LinkedIn agregue ya está soportada sin tocar
  código.

Y hay una salida de emergencia: si algo se rompe, las herramientas
`linkedin_browser_*` dan control directo del navegador (radiografía de la
página, clic por referencia, escritura en campos) para terminar el trabajo a
mano sin editar el proyecto.

---

## Instalación

```bash
cd linkedin-pilot
npm install
npm run build
```

Requiere Node 20+. Usa el Chrome instalado en el sistema; si no lo encuentra
prueba con Edge y luego con el Chromium de Playwright.

### Registrarlo en Claude Code

Ya quedó registrado en el ámbito de usuario:

```bash
claude mcp add linkedin --scope user -- node "<ruta>/linkedin-pilot/dist/index.js"
```

También hay un `.mcp.json` en la carpeta padre por si prefieres el ámbito de
proyecto. Comprueba con `claude mcp list`.

---

## Puesta en marcha

```bash
npm run login     # abre el navegador; inicia sesión a mano una sola vez
npm run doctor    # diagnóstico: navegador, sesión, rutas, banco de respuestas
```

Todo lo persistente vive en `~/.linkedin-pilot/`:

| Ruta | Qué guarda |
|---|---|
| `browser-profile/` | Perfil de Chrome con las cookies de sesión |
| `state.json` | Postulaciones, interacciones y contadores diarios |
| `answers.json` | Banco de respuestas reutilizables y ruta del CV |
| `screenshots/` | Capturas automáticas cuando algo falla |
| `logs/` | Registro diario en JSON |

---

## Uso desde la terminal

```bash
linkedin-pilot status                      # ¿hay sesión?
linkedin-pilot profile                     # lee tu perfil completo
linkedin-pilot jobs "ingeniero de datos"   # busca ofertas con Solicitud sencilla
linkedin-pilot job 4021234567              # detalle de una oferta
linkedin-pilot apply 4021234567            # SIMULA la postulación
linkedin-pilot apply 4021234567 --send     # postula de verdad
linkedin-pilot applications                # historial local
```

---

## Herramientas MCP

### Sesión
| Herramienta | Qué hace |
|---|---|
| `linkedin_session_status` | Estado de la sesión y consumo del día. Empieza siempre por aquí. |
| `linkedin_login` | Abre el navegador para que inicies sesión a mano. |
| `linkedin_session_cookies` | Exporta o importa cookies (`li_at`, `JSESSIONID`). |
| `linkedin_close_browser` | Cierra el navegador; la sesión queda guardada. |

### Perfil
| Herramienta | Qué hace |
|---|---|
| `linkedin_profile_read` | Lee un perfil completo (el tuyo o el de otra persona). |
| `linkedin_profile_sections` | Lista las secciones editables y sus campos habituales. |
| `linkedin_profile_inspect_form` | Abre el editor y devuelve los campos **reales** sin guardar nada. |
| `linkedin_profile_edit` | Rellena cualquier sección por etiqueta y guarda si se lo pides. |
| `linkedin_profile_headline` | Atajo para el titular. |
| `linkedin_profile_about` | Atajo para "Acerca de". |
| `linkedin_profile_image` | Sube foto de perfil o portada. |
| `linkedin_profile_open_to_work` | Configura "Abierto a trabajar". |
| `linkedin_profile_custom_url` | Cambia la URL personalizada. |

Secciones disponibles en `linkedin_profile_edit`, con sus rutas verificadas
contra LinkedIn el 2026-09-01: `intro`, `about`, `experience`, `education`,
`skill`, `certification`, `project`, `language`, `course`, `honor`,
`publication`, `organization`, `patent`, `contactInfo`, `openToWork`.

**Flujo recomendado la primera vez que tocas una sección:**

```
1. linkedin_profile_inspect_form { "section": "experience" }
   → te dice exactamente qué campos existen hoy y cuáles son obligatorios
2. linkedin_profile_edit { "section": "experience", "values": {...}, "save": false }
   → los rellena y te muestra qué quedó; revisas en pantalla
3. linkedin_profile_edit { ..., "save": true }
```

### Personas y contenido
| Herramienta | Qué hace |
|---|---|
| `linkedin_people_search` | Busca personas con filtros de grado de contacto. |
| `linkedin_connect` | Invitación a conectar, con nota opcional. |
| `linkedin_message` | Mensaje directo. |
| `linkedin_follow` | Seguir o dejar de seguir. |
| `linkedin_endorse` | Validar aptitudes. |
| `linkedin_invitations` | Listar, aceptar, ignorar o retirar invitaciones. |
| `linkedin_posts_read` | Publicaciones del feed o de un perfil. |
| `linkedin_post_react` | Reaccionar (`like`, `celebrate`, `support`, `love`, `insightful`, `funny`). |
| `linkedin_post_comment` | Comentar. |
| `linkedin_post_create` | Publicar en el feed. |
| `linkedin_notifications` | Leer notificaciones. |

### Empleos
| Herramienta | Qué hace |
|---|---|
| `linkedin_jobs_search` | Búsqueda con filtros de fecha, experiencia, modalidad y tipo. |
| `linkedin_job_detail` | Detalle completo de una oferta. |
| `linkedin_job_apply` | Solicitud sencilla paso a paso. **Simula por defecto.** |
| `linkedin_job_save` | Guardar o quitar de guardados. |
| `linkedin_my_jobs` | Ofertas guardadas o solicitudes según LinkedIn. |
| `linkedin_applications_log` | Historial local con las respuestas que diste. |

### Soporte
| Herramienta | Qué hace |
|---|---|
| `linkedin_answers_bank` | Consulta y edita las respuestas reutilizables y el CV por defecto. |
| `linkedin_usage` | Consumo frente a los topes diarios. |
| `linkedin_browser_snapshot` | Radiografía de la página: enlaces, botones y campos con referencia. |
| `linkedin_browser_navigate` / `_click` / `_type` / `_scroll` / `_screenshot` | Control manual del navegador. |
| `linkedin_voyager_request` | Llamada directa a la API interna de LinkedIn. |

---

## Cómo funciona la postulación

`linkedin_job_apply` **simula por defecto**. Recorre el asistente completo,
rellena lo que sabe y se detiene justo antes de enviar:

```json
{ "job": "4021234567" }
```

Si el formulario pide algo que no sabe, no inventa: devuelve
`status: "needs-answers"` con la lista exacta de preguntas, sus opciones y una
captura. Se las pasas y vuelve a intentar:

```json
{
  "job": "4021234567",
  "answers": { "Años de experiencia en Python": "5" },
  "dryRun": false,
  "confirm": true
}
```

Las respuestas quedan guardadas en el banco, así que la siguiente oferta que
pregunte lo mismo —aunque lo redacte distinto o en otro idioma— ya no se
atasca. Cuanto más completo el banco, menos intervención necesitas.

Detalles que importan:

- Las ofertas que no son Solicitud sencilla devuelven `status: "external"` con
  el enlace de la empresa. No se puede completar desde LinkedIn.
- "Seguir a la empresa" viene marcado por defecto en LinkedIn; aquí se
  **desmarca** salvo que pidas `followCompany: true`.
- Cada postulación queda registrada, así que no repites ofertas.

---

## Cuidados con la cuenta

Automatizar LinkedIn va contra sus condiciones de uso y las cuentas que se pasan
de volumen terminan restringidas. El proyecto está construido para quedarse muy
por debajo del umbral:

- **Toda acción visible para terceros exige `confirm: true`.** Invitaciones,
  mensajes, comentarios, publicaciones y postulaciones no salen por accidente.
- **Topes diarios conservadores**, con contador persistente:

  | Acción | Tope | Variable de entorno |
  |---|---|---|
  | Invitaciones enviadas | 20 | `LINKEDIN_PILOT_MAX_INVITATIONS` |
  | Respuestas a invitaciones | 100 | `LINKEDIN_PILOT_MAX_INVITATION_RESPONSES` |
  | Validaciones de aptitudes | 20 | `LINKEDIN_PILOT_MAX_ENDORSEMENTS` |
  | Mensajes | 25 | `LINKEDIN_PILOT_MAX_MESSAGES` |
  | Postulaciones | 20 | `LINKEDIN_PILOT_MAX_APPLICATIONS` |
  | Reacciones | 50 | `LINKEDIN_PILOT_MAX_REACTIONS` |
  | Comentarios | 15 | `LINKEDIN_PILOT_MAX_COMMENTS` |
  | Seguimientos | 30 | `LINKEDIN_PILOT_MAX_FOLLOWS` |
  | Publicaciones | 3 | `LINKEDIN_PILOT_MAX_POSTS` |

- **Ritmo humano**: pausas con variación aleatoria, escritura con cadencia
  irregular y desplazamiento por pasos.
- **Un navegador normal**: Chrome real, ventana visible, sin el marcador
  `navigator.webdriver`.

Subir los topes es tu decisión, pero los valores por defecto son lo que mantiene
la cuenta sana.

---

## Configuración

| Variable | Por defecto | Para qué |
|---|---|---|
| `LINKEDIN_PILOT_HOME` | `~/.linkedin-pilot` | Carpeta de datos |
| `LINKEDIN_PILOT_HEADLESS` | `false` | Ocultar la ventana (no recomendado) |
| `LINKEDIN_PILOT_CHANNEL` | `chrome` | `chrome`, `msedge` o `chromium` |
| `LINKEDIN_PILOT_LOCALE` | `es-CO` | Idioma del navegador |
| `LINKEDIN_PILOT_TZ` | `America/Bogota` | Zona horaria |
| `LINKEDIN_PILOT_REQUIRE_CONFIRM` | `true` | Exigir confirmación explícita |
| `LINKEDIN_PILOT_MIN_DELAY` / `_MAX_DELAY` | `700` / `2200` | Rango de pausa entre acciones (ms) |
| `LINKEDIN_PILOT_VERBOSE` | `false` | Diagnóstico detallado en stderr |

---

## Pruebas

```bash
npm test              # emparejado de etiquetas + arranque del servidor MCP
npm run test:forms    # motor de formularios contra el HTML real de LinkedIn
npm run test:live     # editores de perfil, empleos y personas con tu sesión
```

`test:matching` cubre lo más delicado: que pedir un campo no escriba en otro,
que el glosario funcione en los dos idiomas y que el banco de respuestas no se
invente una respuesta para una pregunta que no conoce.

`test:live` necesita sesión iniciada. Abre los editores de perfil para
comprobar que exponen sus campos, y hace una búsqueda de empleos y otra de
personas. **No guarda ni envía nada.** Es lo que hay que correr cuando algo
deje de funcionar: dice en qué punto se rompió.

---

## Cuando LinkedIn cambie algo

Pasará. El orden para arreglarlo, de menos a más esfuerzo:

1. `linkedin_profile_inspect_form` o `linkedin_browser_snapshot` para ver qué
   campos y botones hay **ahora**.
2. Terminar la tarea con `linkedin_browser_click` y `linkedin_browser_type`.
3. Si el cambio es permanente, ajustar la ruta en `SECTIONS`
   (`src/tools/profile.ts`) o añadir el término nuevo al glosario
   (`src/text.ts`). Casi nunca hace falta más.
