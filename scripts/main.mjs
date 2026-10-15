import { EFFORTS, MODELS, MODULE_ID, SHORTCUTS } from "./constants.mjs";
import { ask, cancelRequest, describeError, isBusy, resetConversation } from "./claude.mjs";
import { gmHelp, gmStatus, playerHelp } from "./help.mjs";
import { summariesFor } from "./summary.mjs";
import { ClaudePanel } from "./panel.mjs";
import { beginTurn, clearUndo, describeLast, endTurn, loadUndo, undoCount, undoLast } from "./undo.mjs";
import { t } from "./i18n.mjs";

const SOCKET = `module.${MODULE_ID}`;

const { escapeHTML, cleanHTML } = foundry.utils;
/** /claude, /claude! (strongest model, high effort) and /ia or /ai (quick model, low effort). */
const COMMAND = /^\/(claude!|claude|ia|ai)(?:\s+([\s\S]*))?$/i;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const register = (key, data) => game.settings.register(MODULE_ID, key, {
    name: `CLAUDEGM.Settings.${data.label}.Name`,
    hint: `CLAUDEGM.Settings.${data.label}.Hint`,
    config: true,
    restricted: true,
    ...data
  });


  // Anthropic API. Client scope: the key stays in the GM's browser and is never synced to players.
  register("apiKey", { label: "ApiKey", scope: "client", type: String, default: "" });
  register("model", { label: "Model", scope: "client", type: String, choices: MODELS, default: "claude-opus-5-5" });
  register("effort", { label: "Effort", scope: "client", type: String, choices: EFFORTS, default: "medium" });

  register("confirmChanges", { label: "Confirm", scope: "world", type: Boolean, default: true });
  register("allowPlayers", { label: "AllowPlayers", scope: "world", type: Boolean, default: false });
  register("instructions", { label: "Instructions", scope: "world", type: String, default: "" });
});

Hooks.once("ready", () => {
  if ( !game.user.isGM ) return;
  loadUndo();
  ClaudePanel.load();
});

// Mask the API key field in the settings window.
Hooks.on("renderSettingsConfig", (app, html) => {
  const input = html.querySelector?.(`input[name="${MODULE_ID}.apiKey"]`);
  if ( input ) {
    input.type = "password";
    input.autocomplete = "off";
  }
});

/* -------------------------------------------- */
/*  Chat command                                */
/* -------------------------------------------- */

/** Since v14 the chat input is a rich-text editor and messages arrive as HTML (e.g. "<p>/claude oi</p>"). */
function toPlainText(message) {
  const template = document.createElement("template");
  template.innerHTML = String(message ?? "");
  template.content.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  template.content.querySelectorAll("p").forEach(p => p.append("\n"));
  return template.content.textContent.trim();
}

/** "claude!" → strong, "ia" → quick, otherwise the configured defaults. */
const modeFor = command => ({ "claude!": "strong", ia: "quick", ai: "quick" })[command.toLowerCase()] ?? "normal";

function onCommand(message) {
  const match = toPlainText(message).match(COMMAND);
  if ( !match ) return false;
  const text = match[2]?.trim() ?? "";
  const mode = modeFor(match[1]);
  if ( !game.user.isGM ) {
    askAsPlayer(text);
    return true;
  }
  handleCommand(text, ChatView, mode).catch(reportError);
  return true;
}

function reportError(err) {
  console.error(`${MODULE_ID} |`, err);
  ui.notifications.error(`Claude GM: ${err.message}`);
}

Hooks.once("init", () => {
  const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
  // v14+: register in the official chat command registry.
  if ( ChatLog.CHAT_COMMANDS ) {
    ChatLog.CHAT_COMMANDS.claude = {
      rgx: /^\/(?:claude!?|ia|ai)(?:\s|$|<)/i,
      isMultiline: false,
      fn: (command, match) => {
        onCommand(match.input);
        return false; // don't post the raw command
      }
    };
  }
  // v13: plain-text chatMessage hook.
  else Hooks.on("chatMessage", (chatLog, message) => (onCommand(message) ? false : undefined));
});

/* -------------------------------------------- */
/*  Requests (shared by the chat and the panel)  */
/* -------------------------------------------- */

const busyNow = () => Boolean(currentJob) || isBusy();
const pendingHTML = () => `<p class="claude-gm-pending"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Chat.Thinking")}</p>`;
const enrich = html => foundry.applications.ux.TextEditor.implementation.enrichHTML(html);

/**
 * Where a request's output goes. Each view returns an "entry" with show(html) to replace its content.
 * The chat view whispers a message to the GM; the panel view appends to the panel conversation;
 * the player view whispers to the asking player and the GMs.
 */
const ChatView = {
  async note(html) { await postNote(html); },
  async begin(text) {
    const request = `<blockquote class="claude-gm-request">${escapeHTML(text)}</blockquote>`;
    const message = await postNote(`${request}${pendingHTML()}`);
    return { show: html => message.update({ content: wrap(`${request}${html}`) }) };
  }
};

const PanelView = {
  async note(html) {
    ClaudePanel.entries.push({ role: "claude", html: await enrich(html) });
    ClaudePanel.refresh();
  },
  async begin(text) {
    ClaudePanel.entries.push({ role: "user", html: escapeHTML(text) });
    const entry = { role: "claude", html: pendingHTML() };
    ClaudePanel.entries.push(entry);
    ClaudePanel.refresh();
    // Enrichment is async: only the newest call may write, so a slow progress update can't overwrite the answer.
    let latest = 0;
    return {
      show: async html => {
        const mine = ++latest;
        const enriched = await enrich(html);
        if ( mine !== latest ) return;
        entry.html = enriched;
        ClaudePanel.refresh();
      }
    };
  }
};

function playerView(user) {
  const whisper = () => [user.id, ...ChatMessage.implementation.getWhisperRecipients("GM").map(u => u.id)];
  const create = html => ChatMessage.implementation.create({
    content: wrap(html), speaker: { alias: "Claude" }, whisper: whisper(), flags: { [MODULE_ID]: { response: true } }
  });
  return {
    async note(html) { await create(html); },
    async begin(text) {
      const request = `<blockquote class="claude-gm-request"><b>${escapeHTML(user.name)}:</b> ${escapeHTML(text)}</blockquote>`;
      const message = await create(`${request}${pendingHTML()}`);
      return { show: html => message.update({ content: wrap(`${request}${html}`) }) };
    }
  };
}

/**
 * Command words, in English and Portuguese. Every command accepts both languages; the help page shows the
 * ones for the interface language.
 */
const COMMANDS = {
  help: ["help", "ajuda", "comandos"],
  status: ["status", "config", "estado"],
  panel: ["panel", "painel", "janela"],
  summary: ["summary", "sheet", "resumo", "ficha"],
  stop: ["stop", "parar", "cancelar"],
  reset: ["reset", "new", "nova", "limpar"],
  queue: ["queue", "fila"],
  clearQueue: ["clear queue", "queue clear", "fila limpar", "limpar fila"],
  undo: ["undo", "desfazer"],
  clearUndo: ["undo clear", "clear undo", "desfazer limpar", "limpar desfazer"]
};

/** The command a text is (case and spacing insensitive), or null when it is a request for Claude. */
function commandOf(text) {
  const lower = text.toLowerCase().replace(/\s+/g, " ").trim();
  return Object.keys(COMMANDS).find(name => COMMANDS[name].includes(lower)) ?? null;
}

/** Commands that are not questions for Claude. Anything else is queued as a request. */
async function handleCommand(text, view=ChatView, mode="normal") {
  const command = text ? commandOf(text) : "help";
  switch ( command ) {
    case "help": return view.note(gmHelp());
    case "status": return view.note(gmStatus({ undoCount: undoCount() }));
    case "panel": return ClaudePanel.toggle();
    case "summary": {
      const f = ClaudePanel.focused;
      const focused = f ? (await foundry.utils.fromUuid(f.uuid)) : null;
      return view.note(summariesFor(game.user, { focused: focused?.actor ?? (focused?.documentName === "Actor" ? focused : null) }));
    }
    case "stop": return stopRequest();
    case "reset":
      resetConversation();
      return view.note(`<p>${t("Chat.Reset")}</p>`);
    case "queue": return view.note(queueReport());
    case "clearQueue": return clearPlayerQueue(view);
    case "clearUndo": {
      const n = undoCount();
      clearUndo();
      return view.note(`<p>${t("Undo.Cleared", { count: n })}</p>`);
    }
    case "undo":
      if ( busyNow() ) return ui.notifications.warn(t("Undo.Wait"));
      return undoLastRequest(view);
    default:
      return enqueue({ kind: "gm", text, view, mode });
  }
}

/* -------------------------------------------- */
/*  Request queue                               */
/* -------------------------------------------- */

/**
 * Requests run one at a time (it protects the Claude usage limit and avoids overlapping approval dialogs).
 * GM requests go ahead of player questions but never interrupt the running one.
 * @type {{kind: "gm"|"player", text: string, view: object, mode: string, user?: User, entry?: object}[]}
 */
const queue = [];
let currentJob = null;
const MAX_PLAYER_QUEUE = 8;
const queuedHTML = pos => `<p class="claude-gm-pending"><i class="fa-solid fa-hourglass-half"></i> ${t("Queue.Position", { position: pos })}</p>`;

/**
 * Add a job to the queue. The job is queued synchronously (so simultaneous arrivals see each other in the
 * duplicate and queue-full checks); its chat message / panel entry is created in the background.
 */
function enqueue(job) {
  job.entry = job.view.begin(job.text);
  if ( job.kind === "gm" ) {
    const firstOther = queue.findIndex(j => j.kind !== "gm");
    if ( firstOther < 0 ) queue.push(job);
    else queue.splice(firstOther, 0, job);
  }
  else queue.push(job);
  if ( currentJob ) refreshPositions();
  pump();
  return job.entry;
}

function refreshPositions() {
  queue.forEach((job, i) => job.entry.then(entry => entry.show(queuedHTML(i + 1))));
}

async function pump() {
  if ( currentJob || !queue.length ) return;
  currentJob = queue.shift();
  refreshPositions();
  ClaudePanel.refresh();
  try {
    await runRequest(currentJob.text, currentJob.view, {
      mode: currentJob.mode, user: currentJob.user, entry: await currentJob.entry
    });
  } catch (err) {
    reportError(err);
  } finally {
    currentJob = null;
    ClaudePanel.refresh();
    pump();
  }
}

function queueReport() {
  const who = job => job.user?.name ?? t("Queue.Gm");
  const line = (job, label) => `<li>${label}: <b>${escapeHTML(who(job))}</b> — ${escapeHTML(job.text.slice(0, 80))}</li>`;
  const items = [
    currentJob ? line(currentJob, t("Queue.Now")) : "",
    ...queue.map((job, i) => line(job, `#${i + 1}`))
  ].join("");
  return items ? `<p><b>${t("Queue.Title")}</b></p><ul>${items}</ul>` : `<p>${t("Queue.Empty")}</p>`;
}

async function clearPlayerQueue(view) {
  const removed = queue.filter(j => j.kind === "player");
  for ( const job of removed ) {
    queue.splice(queue.indexOf(job), 1);
    job.entry.then(entry => entry.show(`<p>${t("Queue.Removed")}</p>`));
  }
  refreshPositions();
  return view.note(`<p>${t("Queue.Cleared", { count: removed.length })}</p>`);
}

function stopRequest() {
  cancelRequest();
}

/** The panel's focused document, as context for the request. */
function focusContext() {
  const f = ClaudePanel.focused;
  if ( !f ) return "";
  return `<focused_document type="${f.documentName}" uuid="${f.uuid}">${f.name}</focused_document>\n`
    + "Requests like \"this\", \"it\" or \"this sheet\" refer to the focused document.\n";
}

/**
 * Run one request.
 * @param {string} text
 * @param {object} view
 * @param {object} [options]
 * @param {"normal"|"strong"|"quick"} [options.mode]
 * @param {User} [options.user]  A player asking (read-only, separate conversation).
 * @param {object} [options.entry]  Output entry already created (queued requests).
 */
async function runRequest(text, view, { mode="normal", user=null, entry=null }={}) {
  entry ??= await view.begin(text);
  entry.show(pendingHTML());
  const steps = [];
  const texts = [];
  const progress = () => entry.show(`${texts.length ? markdown(texts.join("\n\n")) : ""}${renderSteps(steps, true)}${pendingHTML()}`);
  const onStep = step => { steps.push(step); progress(); };
  const onText = tx => { texts.push(tx); progress(); };
  const shortcut = SHORTCUTS[mode] ?? {};

  const recordsUndo = !user;
  if ( recordsUndo ) beginTurn(text);
  ClaudePanel.refresh();
  try {
    const fullText = user ? text : `${focusContext()}${text}`;
    const result = await ask(fullText, { onStep, onText, user, model: shortcut.api, effort: shortcut.effort });
    const notes = result.notes.map(n => `<p class="claude-gm-note">${escapeHTML(n)}</p>`).join("");
    await entry.show(`${markdown(result.text)}${notes}${renderSteps(result.steps)}`);
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    const msg = describeError(err);
    if ( (msg !== t("Error.Canceled")) && !user ) ui.notifications.error(`${t("Error.Talking")}: ${msg}`);
    await entry.show(`<p class="claude-gm-error">${escapeHTML(msg)}</p>${renderSteps(steps)}`);
  } finally {
    if ( recordsUndo ) endTurn();
    ClaudePanel.refresh();
  }
}

async function undoLastRequest(view) {
  const description = describeLast();
  if ( !description ) return view.note(`<p>${t("Undo.Nothing")}</p>`);
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: t("Undo.Title") },
    content: `<div class="claude-gm-confirm">${description}</div>`,
    position: { width: 520 },
    rejectClose: false
  });
  if ( ok !== true ) return;
  const report = await undoLast();
  return view.note(`<p><b>${t("Undo.Done")}</b></p><ul>${report.map(r => `<li>${escapeHTML(r)}</li>`).join("")}</ul>`);
}

/* -------------------------------------------- */
/*  Players asking (read-only)                  */
/* -------------------------------------------- */

/** On a player's client: send the question to the GM's client. */
function askAsPlayer(text) {
  const command = text ? commandOf(text) : "help";
  // Help is answered locally: it costs nothing and works even when the GM has not enabled players.
  if ( command === "help" ) {
    ChatMessage.implementation.create({
      content: wrap(playerHelp()), speaker: { alias: "Claude" }, whisper: [game.user.id], flags: { [MODULE_ID]: { response: true } }
    });
    return;
  }
  // The summary is built locally from the player's own sheet: instant and free, even if the GM is away.
  if ( command === "summary" ) {
    ChatMessage.implementation.create({
      content: wrap(summariesFor(game.user)), speaker: { alias: "Claude" }, whisper: [game.user.id],
      flags: { [MODULE_ID]: { response: true } }
    });
    return;
  }
  if ( !game.settings.get(MODULE_ID, "allowPlayers") ) {
    ui.notifications.warn(t("Chat.GmOnly"));
    return;
  }
  if ( !game.users.activeGM ) return ui.notifications.warn(t("Chat.NoGm"));
  if ( command === "reset" ) {
    game.socket.emit(SOCKET, { type: "playerReset", userId: game.user.id });
    return ui.notifications.info(t("Chat.Reset"));
  }
  game.socket.emit(SOCKET, { type: "playerAsk", userId: game.user.id, text });
  ui.notifications.info(t("Chat.AskSent"));
}

/** Per-player limits (enforced on the GM's side): one question every 15 s, at most 20 per hour. */
const PLAYER_MIN_INTERVAL_MS = 15_000;
const PLAYER_MAX_PER_HOUR = 20;
const playerAsks = new Map();

/** Returns a message explaining the wait, or null when the player may ask now (and records the ask). */
function playerRateLimit(user) {
  const now = Date.now();
  const recent = (playerAsks.get(user.id) ?? []).filter(t => now - t < 3_600_000);
  const last = recent.at(-1);
  if ( last && (now - last < PLAYER_MIN_INTERVAL_MS) ) {
    return t("Queue.WaitSeconds", { name: user.name, seconds: Math.ceil((PLAYER_MIN_INTERVAL_MS - (now - last)) / 1000) });
  }
  if ( recent.length >= PLAYER_MAX_PER_HOUR ) return t("Queue.HourLimit", { name: user.name, max: PLAYER_MAX_PER_HOUR });
  recent.push(now);
  playerAsks.set(user.id, recent);
  return null;
}

/** On the active GM's client: answer a player's question. */
function onSocket(data) {
  if ( !game.user.isActiveGM ) return;
  if ( !["playerAsk", "playerReset"].includes(data?.type) ) return;
  const user = game.users.get(data.userId);
  if ( !user || user.isGM || !game.settings.get(MODULE_ID, "allowPlayers") ) return;
  if ( data.type === "playerReset" ) {
    resetConversation(user);
    return;
  }
  const text = String(data.text ?? "").slice(0, 1000);
  const view = playerView(user);
  if ( (currentJob?.user?.id === user.id) || queue.some(j => j.user?.id === user.id) ) {
    view.note(`<p>${escapeHTML(t("Queue.Pending", { name: user.name }))}</p>`);
    return;
  }
  if ( queue.filter(j => j.kind === "player").length >= MAX_PLAYER_QUEUE ) {
    view.note(`<p>${escapeHTML(t("Queue.Full", { name: user.name }))}</p>`);
    return;
  }
  const limited = playerRateLimit(user);
  if ( limited ) {
    view.note(`<p>${escapeHTML(limited)}</p>`);
    return;
  }
  enqueue({ kind: "player", view, user, text, mode: "quick" }).catch(reportError);
}

Hooks.once("ready", () => game.socket.on(SOCKET, onSocket));

/* -------------------------------------------- */
/*  Panel, sheet buttons and token HUD          */
/* -------------------------------------------- */

/** Panel input: "!pedido" uses the strong model, "?pedido" the quick one. */
function submitFromPanel(raw) {
  let text = raw.trim();
  let mode = "normal";
  if ( text.startsWith("!") ) { mode = "strong"; text = text.slice(1).trim(); }
  else if ( text.startsWith("?") && (text.length > 1) ) { mode = "quick"; text = text.slice(1).trim(); }
  return handleCommand(text, PanelView, mode).catch(reportError);
}

ClaudePanel.handlers = {
  submit: submitFromPanel,
  stop: stopRequest,
  isBusy: busyNow
};

Hooks.on("getSceneControlButtons", controls => {
  const tokens = controls.tokens ?? controls.token;
  if ( !game.user.isGM || !tokens?.tools ) return;
  tokens.tools.claudeGM = {
    name: "claudeGM",
    title: "Claude GM",
    icon: "fa-solid fa-robot",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => ClaudePanel.toggle()
  };
});

// "Ask Claude" button in the header of every document sheet (actors, items, journals, scenes...).
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  const doc = app.document;
  if ( !game.user.isGM || !(doc instanceof foundry.abstract.Document) ) return;
  if ( controls.some(c => c.action === "claudeGM") ) return;
  controls.push({
    action: "claudeGM",
    icon: "fa-solid fa-robot",
    label: t("Panel.AskClaude"),
    onClick: () => ClaudePanel.focus(doc)
  });
});

// Robot button on the token HUD (right click on a token).
Hooks.on("renderTokenHUD", (hud, html) => {
  if ( !game.user.isGM ) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const column = root?.querySelector(".col.right");
  if ( !column || column.querySelector(".claude-gm-hud") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon claude-gm-hud";
  button.dataset.tooltip = "Claude";
  button.innerHTML = `<i class="fa-solid fa-robot"></i>`;
  button.addEventListener("click", () => {
    const token = hud.document ?? hud.object?.document;
    ClaudePanel.focus(token?.actor && !token.actorLink ? token : (token?.actor ?? token));
  });
  column.append(button);
});

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

const wrap = html => `<div class="claude-gm">${html}</div>`;

/** Whisper a Claude-authored message to the current GM only. */
function postNote(html) {
  return ChatMessage.implementation.create({
    content: wrap(html),
    speaker: { alias: "Claude" },
    whisper: [game.user.id],
    flags: { [MODULE_ID]: { response: true } }
  });
}

let converter;
function markdown(text) {
  converter ??= new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true, openLinksInNewWindow: true });
  return cleanHTML(converter.makeHtml(text || ""));
}

function renderSteps(steps, open=false) {
  if ( !steps.length ) return "";
  const items = steps.map(s => {
    const icon = s.error ? "fa-circle-xmark" : "fa-circle-check";
    const err = s.error ? ` — <span class="claude-gm-error">${escapeHTML(s.error)}</span>` : "";
    return `<li><i class="fa-solid ${icon}"></i> <code>${escapeHTML(s.tool)}</code>${err}</li>`;
  }).join("");
  return `<details class="claude-gm-steps"${open ? " open" : ""}><summary>${t("Chat.Actions")} (${steps.length})</summary><ul>${items}</ul></details>`;
}
