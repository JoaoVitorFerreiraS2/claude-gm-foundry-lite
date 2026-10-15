import { EFFORTS, MODELS, MODULE_ID, SHORTCUTS } from "./constants.mjs";
import { ask, cancelRequest, currentContext, describeError, isBusy, resetConversation } from "./claude.mjs";
import {
  askViaBridge, cancelBridgeRequest, connectBridge, isBridgeBusy, remoteLog, resetBridgeConversation
} from "./bridge-client.mjs";
import { gmHelp, gmStatus, playerHelp } from "./help.mjs";
import { summariesFor } from "./summary.mjs";
import { composeLetter, draftPrompt, letterOf, MailApp, receiveLetter, updateLetter } from "./letters.mjs";
import { addClue, analysisRequest, BOARD_SYSTEM, BoardApp, boardJournal, removeClue, saveAnalysis } from "./board.mjs";
import { ClaudePanel } from "./panel.mjs";
import { beginTurn, clearUndo, describeLast, endTurn, loadUndo, undoCount, undoLast } from "./undo.mjs";

const useBridge = () => false;
const SOCKET = `module.${MODULE_ID}`;

const { escapeHTML, cleanHTML } = foundry.utils;
/** /claude, /claude! (strongest model, high effort) and /ia (quick model, low effort). */
const COMMAND = /^\/(claude!|claude|ia)(?:\s+([\s\S]*))?$/i;

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
  // The bridge connection also serves Claude Code sessions opened in a terminal, so connect regardless of backend.
  connectBridge();
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
const modeFor = command => ({ "claude!": "strong", ia: "quick" })[command.toLowerCase()] ?? "normal";

function onCommand(message) {
  const match = toPlainText(message).match(COMMAND);
  if ( !match ) return false;
  const text = match[2]?.trim() ?? "";
  const mode = modeFor(match[1]);
  if ( !game.user.isGM ) {
    askAsPlayer(text);
    return true;
  }
  remoteLog(`comando recebido: ${match[0].slice(0, 80)}`);
  handleCommand(text, ChatView, mode).catch(reportError);
  return true;
}

function reportError(err) {
  console.error(`${MODULE_ID} |`, err);
  remoteLog(`erro: ${err.stack ?? err}`);
  ui.notifications.error(`Claude GM: ${err.message}`);
}

Hooks.once("init", () => {
  const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
  // v14+: register in the official chat command registry.
  if ( ChatLog.CHAT_COMMANDS ) {
    ChatLog.CHAT_COMMANDS.claude = {
      rgx: /^\/(?:claude!?|ia)(?:\s|$|<)/i,
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

const busyNow = () => Boolean(currentJob) || isBusy() || isBridgeBusy();
const pendingHTML = () => `<p class="claude-gm-pending"><i class="fa-solid fa-spinner fa-spin"></i> ${game.i18n.localize("CLAUDEGM.Thinking")}</p>`;
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

/** Commands that are not questions for Claude. Returns true when handled. */
async function handleCommand(text, view=ChatView, mode="normal") {
  const lower = text.toLowerCase();
  if ( !text || ["ajuda", "help", "comandos"].includes(lower) ) return view.note(gmHelp());
  if ( ["status", "config", "estado"].includes(lower) ) {
    return view.note(gmStatus({ undoCount: undoCount() }));
  }
  if ( ["painel", "panel", "janela"].includes(lower) ) return ClaudePanel.toggle();
  if ( ["correio", "cartas"].includes(lower) ) return MailApp.open();
  if ( ["quadro", "investigacao", "investigação"].includes(lower) ) return BoardApp.open();
  if ( lower.startsWith("pista ") ) {
    const problem = await addClue(game.user, text.slice(6));
    if ( problem ) return ui.notifications.warn(`Quadro: ${problem}`);
    return ui.notifications.info("🔎 Pista adicionada ao quadro.");
  }
  if ( lower === "carta" ) return view.note("<p>Os jogadores escrevem cartas com <b>/claude carta</b>. As respostas você revisa em <b>/claude correio</b>.</p>");
  if ( ["resumo", "ficha"].includes(lower) ) {
    const f = ClaudePanel.focused;
    const focused = f ? (await foundry.utils.fromUuid(f.uuid)) : null;
    return view.note(summariesFor(game.user, { focused: focused?.actor ?? (focused?.documentName === "Actor" ? focused : null) }));
  }
  if ( ["parar", "stop", "cancelar"].includes(lower) ) return stopRequest();
  if ( ["reset", "nova", "new", "limpar"].includes(lower) ) {
    resetConversation();
    resetBridgeConversation();
    return view.note(`<p>${game.i18n.localize("CLAUDEGM.Reset")}</p>`);
  }
  if ( lower === "fila" ) return view.note(queueReport());
  if ( ["fila limpar", "limpar fila"].includes(lower) ) return clearPlayerQueue(view);
  if ( ["desfazer limpar", "limpar desfazer", "undo clear"].includes(lower) ) {
    const n = undoCount();
    clearUndo();
    return view.note(`<p>Histórico do desfazer apagado (${n} pedido(s)). Nada no mundo foi alterado.</p>`);
  }
  if ( ["desfazer", "undo"].includes(lower) ) {
    if ( busyNow() ) return ui.notifications.warn("Espere o pedido atual terminar para desfazer.");
    return undoLastRequest(view);
  }
  return enqueue({ kind: "gm", text, view, mode });
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
const queuedHTML = pos => `<p class="claude-gm-pending"><i class="fa-solid fa-hourglass-half"></i> Na fila — posição ${pos}</p>`;

/**
 * Add a job to the queue. The job is queued synchronously (so simultaneous arrivals see each other in the
 * duplicate and queue-full checks); its chat message / panel entry is created in the background.
 */
function enqueue(job) {
  job.entry = job.view.begin(job.display ?? job.text);
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
      mode: currentJob.mode, user: currentJob.user, entry: await currentJob.entry, ...(currentJob.options ?? {})
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
  const who = job => job.user?.name ?? ({ letter: "Correio", board: "Quadro" }[job.kind] ?? "Mestre");
  const line = (job, label) => `<li>${label}: <b>${escapeHTML(who(job))}</b> — ${escapeHTML((job.display ?? job.text).slice(0, 80))}</li>`;
  const items = [
    currentJob ? line(currentJob, "Agora") : "",
    ...queue.map((job, i) => line(job, `${i + 1}º`))
  ].join("");
  return items ? `<p><b>Fila do Claude</b></p><ul>${items}</ul>` : "<p>A fila do Claude está vazia.</p>";
}

async function clearPlayerQueue(view) {
  const removed = queue.filter(j => j.kind === "player");
  for ( const job of removed ) {
    queue.splice(queue.indexOf(job), 1);
    job.entry.then(entry => entry.show("<p>Pergunta removida da fila pelo Mestre.</p>"));
  }
  refreshPositions();
  return view.note(`<p>${removed.length} pergunta(s) de jogadores removida(s) da fila.</p>`);
}

function stopRequest() {
  cancelRequest();
  cancelBridgeRequest();
}

/** The panel's focused document, as context for the request. */
function focusContext() {
  const f = ClaudePanel.focused;
  if ( !f ) return "";
  return `<documento_em_foco tipo="${f.documentName}" uuid="${f.uuid}">${f.name}</documento_em_foco>\n`
    + "Pedidos como \"este\", \"ele\" ou \"esta ficha\" se referem ao documento em foco.\n";
}

/**
 * Run one request.
 * @param {string} text
 * @param {object} view
 * @param {object} [options]
 * @param {"normal"|"strong"|"quick"} [options.mode]
 * @param {User} [options.user]  A player asking (read-only, separate conversation).
 * @param {object} [options.entry]  Output entry already created (queued requests).
 * @param {boolean} [options.noTools]  No tools and no GM context (investigation board: clues only).
 * @param {string} [options.system]    System prompt for tool-less requests.
 * @param {boolean} [options.ephemeral] One-off conversation (not added to the GM's ongoing one). Default: noTools.
 * Views may implement done(result) and failed(message), called at the end.
 */
async function runRequest(text, view, { mode="normal", user=null, entry=null, noTools=false, system, ephemeral=noTools }={}) {
  entry ??= await view.begin(text);
  entry.show(pendingHTML());
  const steps = [];
  const texts = [];
  const progress = () => entry.show(`${texts.length ? markdown(texts.join("\n\n")) : ""}${renderSteps(steps, true)}${pendingHTML()}`);
  const onStep = step => { steps.push(step); progress(); };
  const onText = t => { texts.push(t); progress(); };
  const shortcut = SHORTCUTS[mode] ?? {};

  const recordsUndo = !user && !noTools;
  if ( recordsUndo ) beginTurn(text);
  ClaudePanel.refresh();
  try {
    let result;
    if ( useBridge() ) {
      let preamble = "";
      if ( noTools ) preamble = "";
      else if ( !user ) {
        const extra = game.settings.get(MODULE_ID, "instructions")?.trim();
        if ( extra ) preamble += `<instrucoes_do_mestre>\n${extra}\n</instrucoes_do_mestre>\n`;
        preamble += focusContext() + currentContext();
      }
      else preamble = `<jogador>${user.name}${user.character ? ` — personagem ${user.character.name} (${user.character.uuid})` : ""}</jogador>`;
      const bridged = await askViaBridge(preamble ? `${preamble}\n\n${text}` : text,
        { onStep, onText, user, model: shortcut.cli, effort: shortcut.effort, noTools, system, ephemeral });
      result = { text: bridged.text, steps, notes: [] };
    }
    else {
      const fullText = (user || noTools) ? text : `${focusContext()}${text}`;
      result = await ask(fullText, { onStep, onText, user, model: shortcut.api, effort: shortcut.effort,
        noTools, ephemeral, system });
    }
    const notes = result.notes.map(n => `<p class="claude-gm-note">${escapeHTML(n)}</p>`).join("");
    await entry.show(`${markdown(result.text)}${notes}${renderSteps(result.steps)}`);
    await view.done?.(result);
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    const msg = describeError(err);
    if ( (msg !== "Cancelado.") && !user ) ui.notifications.error(`${game.i18n.localize("CLAUDEGM.Error")}: ${msg}`);
    await entry.show(`<p class="claude-gm-error">${escapeHTML(msg)}</p>${renderSteps(steps)}`);
    await view.failed?.(msg);
  } finally {
    if ( recordsUndo ) endTurn();
    ClaudePanel.refresh();
  }
}

async function undoLastRequest(view) {
  const description = describeLast();
  if ( !description ) return view.note("<p>Não há nada para desfazer.</p>");
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Desfazer o último pedido do Claude?" },
    content: `<div class="claude-gm-confirm">${description}</div>`,
    position: { width: 520 },
    rejectClose: false
  });
  if ( ok !== true ) return;
  const report = await undoLast();
  return view.note(`<p><b>Desfeito:</b></p><ul>${report.map(r => `<li>${escapeHTML(r)}</li>`).join("")}</ul>`);
}

/* -------------------------------------------- */
/*  Players asking (read-only)                  */
/* -------------------------------------------- */

/** On a player's client: send the question to the GM's client. */
function askAsPlayer(text) {
  // Help is answered locally: it costs nothing and works even when the GM has not enabled players.
  if ( !text || ["ajuda", "help", "comandos"].includes(text.toLowerCase()) ) {
    ChatMessage.implementation.create({
      content: wrap(playerHelp()), speaker: { alias: "Claude" }, whisper: [game.user.id], flags: { [MODULE_ID]: { response: true } }
    });
    return;
  }
  const lowerText = text.toLowerCase();
  if ( ["carta", "escrever carta"].includes(lowerText) ) return composeLetter(SOCKET);
  if ( ["quadro", "investigacao", "investigação"].includes(lowerText) ) return BoardApp.open();
  if ( lowerText.startsWith("pista ") ) {
    if ( !game.users.activeGM ) return ui.notifications.warn("Nenhum Mestre conectado para registrar a pista.");
    game.socket.emit(SOCKET, { type: "boardAdd", userId: game.user.id, text: text.slice(6) });
    return ui.notifications.info("🔎 Pista enviada ao quadro.");
  }
  // The summary is built locally from the player's own sheet: instant and free, even if the GM is away.
  if ( ["resumo", "ficha"].includes(text.toLowerCase()) ) {
    ChatMessage.implementation.create({
      content: wrap(summariesFor(game.user)), speaker: { alias: "Claude" }, whisper: [game.user.id],
      flags: { [MODULE_ID]: { response: true } }
    });
    return;
  }
  if ( !game.settings.get(MODULE_ID, "allowPlayers") ) {
    ui.notifications.warn(game.i18n.localize("CLAUDEGM.GMOnly"));
    return;
  }
  if ( ["nivel", "nível", "subir de nivel", "subir de nível", "level up"].includes(text.toLowerCase()) ) {
    if ( !game.users.activeGM ) return ui.notifications.warn("Nenhum Mestre conectado para responder.");
    game.socket.emit(SOCKET, { type: "playerAsk", userId: game.user.id, text: "Subir de nível", purpose: "levelup" });
    ui.notifications.info("Pedido de ajuda para subir de nível enviado.");
    return;
  }
  if ( !game.users.activeGM ) return ui.notifications.warn("Nenhum Mestre conectado para responder.");
  if ( ["reset", "nova", "new", "limpar"].includes(text.toLowerCase()) ) {
    game.socket.emit(SOCKET, { type: "playerReset", userId: game.user.id });
    return ui.notifications.info("Conversa com o Claude reiniciada.");
  }
  game.socket.emit(SOCKET, { type: "playerAsk", userId: game.user.id, text });
  ui.notifications.info("Pergunta enviada ao Claude. A resposta chega no chat, só para você e o Mestre.");
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
    return `espere ${Math.ceil((PLAYER_MIN_INTERVAL_MS - (now - last)) / 1000)} s antes da próxima pergunta.`;
  }
  if ( recent.length >= PLAYER_MAX_PER_HOUR ) return `limite de ${PLAYER_MAX_PER_HOUR} perguntas por hora atingido.`;
  recent.push(now);
  playerAsks.set(user.id, recent);
  return null;
}

/** On the active GM's client: answer a player's question. */
function onSocket(data) {
  if ( !game.user.isActiveGM ) return;
  if ( ["letter", "boardAdd", "boardRemove", "boardAnalyze"].includes(data?.type) ) return onPlayerFeature(data).catch(reportError);
  if ( !["playerAsk", "playerReset"].includes(data?.type) ) return;
  const user = game.users.get(data.userId);
  if ( !user || user.isGM || !game.settings.get(MODULE_ID, "allowPlayers") ) return;
  if ( data.type === "playerReset" ) {
    resetConversation(user);
    resetBridgeConversation(user);
    return;
  }
  const text = String(data.text ?? "").slice(0, 1000);
  const view = playerView(user);
  if ( (currentJob?.user?.id === user.id) || queue.some(j => j.user?.id === user.id) ) {
    view.note(`<p>${escapeHTML(user.name)}, sua pergunta anterior ainda não foi respondida. Espere a resposta antes de mandar outra.</p>`);
    return;
  }
  if ( queue.filter(j => j.kind === "player").length >= MAX_PLAYER_QUEUE ) {
    view.note(`<p>${escapeHTML(user.name)}, a fila do Claude está cheia. Tente de novo em instantes.</p>`);
    return;
  }
  const limited = playerRateLimit(user);
  if ( limited ) {
    view.note(`<p>${escapeHTML(user.name)}, ${limited}</p>`);
    return;
  }
  remoteLog(`pergunta de ${user.name}: ${text.slice(0, 80)}`);
  const levelUp = data.purpose === "levelup";
  enqueue({
    kind: "player", view, user,
    display: levelUp ? "Subir de nível" : undefined,
    text: levelUp ? "Quero subir de nível. Use get_level_up_options e, se eu conjuro magias, search_class_spells. Me mostre o que o próximo nível dá e o que eu preciso escolher; para cada escolha, explique as opções em uma linha e recomende 1 ou 2 que combinem com a minha ficha e a minha história, dizendo o porquê. Não aplique nada: eu levo as escolhas ao Mestre." : text,
    mode: levelUp ? "playerDeep" : "quick"
  }).catch(reportError);
}

Hooks.once("ready", () => game.socket.on(SOCKET, onSocket));

/* -------------------------------------------- */
/*  Letters and investigation board             */
/* -------------------------------------------- */

/** Whisper something to one player (and the GMs). */
function tellPlayer(user, html) {
  return ChatMessage.implementation.create({
    content: wrap(html), speaker: { alias: "Claude" }, flags: { [MODULE_ID]: { response: true } },
    whisper: [user.id, ...ChatMessage.implementation.getWhisperRecipients("GM").map(u => u.id)]
  });
}

/** Letters, clues and board analyses coming from players (handled on the active GM's client). */
async function onPlayerFeature(data) {
  const user = game.users.get(data.userId);
  if ( !user || user.isGM ) return;
  switch ( data.type ) {
    case "letter": {
      const page = await receiveLetter(data);
      if ( typeof page === "string" ) return tellPlayer(user, `<p>📜 Carta não enviada: ${escapeHTML(page)}.</p>`);
      remoteLog(`carta de ${user.name} para ${letterOf(page).to}`);
      ui.notifications.info(`📜 ${letterOf(page).characterName} escreveu para ${letterOf(page).to}. Veja em /claude correio.`);
      return queueLetterDraft(page);
    }
    case "boardAdd": {
      const problem = await addClue(user, data.text);
      if ( problem ) tellPlayer(user, `<p>🔎 Pista não adicionada: ${escapeHTML(problem)}.</p>`);
      return;
    }
    case "boardRemove": {
      const problem = await removeClue(user, data.clueId);
      if ( problem ) tellPlayer(user, `<p>🔎 ${escapeHTML(problem)}.</p>`);
      return;
    }
    case "boardAnalyze": {
      if ( !game.settings.get(MODULE_ID, "allowPlayers") ) {
        return tellPlayer(user, "<p>🔎 O Mestre não liberou o Claude para os jogadores; peça a análise a ele.</p>");
      }
      if ( queue.some(j => j.kind === "board") || (currentJob?.kind === "board") ) {
        return tellPlayer(user, "<p>🔎 O quadro já está sendo analisado. A análise aparece no quadro em instantes.</p>");
      }
      const limited = playerRateLimit(user);
      if ( limited ) return tellPlayer(user, `<p>${escapeHTML(user.name)}, ${limited}</p>`);
      return queueBoardAnalysis(user);
    }
  }
}

/** Claude drafts the reply in the background (GM context: notes, factions, secrets). Nothing reaches the player. */
function queueLetterDraft(page, instruction="") {
  const l = letterOf(page);
  const view = {
    async note() {},
    async begin() {
      await updateLetter(page, { status: "drafting" });
      return { show: () => {} };
    },
    async done() {
      const after = letterOf(await foundry.utils.fromUuid(page.uuid));
      if ( after.status !== "drafted" ) {
        await updateLetter(page, { status: "pending", gmNotes: "<p>O Claude não salvou um rascunho. Peça uma nova versão ou responda você mesmo.</p>" });
      }
      const from = l.direction === "out" ? (after.fromName || l.fromName || "?") : l.characterName;
      postNote(`<p>📜 Rascunho pronto: carta de <b>${escapeHTML(from)}</b> para <b>${escapeHTML(l.to)}</b>. Abra com <b>/claude correio</b>.</p>`);
    },
    async failed(msg) {
      await updateLetter(page, { status: "pending", gmNotes: `<p>Erro ao rascunhar: ${escapeHTML(msg)}</p>` });
    }
  };
  return enqueue({
    kind: "letter", view, text: draftPrompt(page, instruction), display: l.direction === "out" ? `Carta: ${l.fromName || "?"} → ${l.characterName}` : `Carta: ${l.characterName} → ${l.to}`, mode: "normal",
    options: { ephemeral: true }
  });
}

/** Claude analyses the board using only the clues (no tools, no GM knowledge). */
async function queueBoardAnalysis(requester) {
  await boardJournal({ create: true });
  const view = {
    async note() {},
    async begin() { return { show: () => {} }; },
    async done(result) {
      await saveAnalysis(markdown(result.text));
      if ( !requester.isGM ) tellPlayer(requester, "<p>🔎 A análise do quadro de investigação foi atualizada. Abra com <b>/claude quadro</b>.</p>");
      else ui.notifications.info("🔎 Análise do quadro atualizada.");
    },
    async failed(msg) {
      if ( !requester.isGM ) tellPlayer(requester, `<p>🔎 Não consegui analisar o quadro: ${escapeHTML(msg)}</p>`);
    }
  };
  return enqueue({
    kind: "board", view, text: analysisRequest(), display: "Análise do quadro de investigação", mode: "normal",
    options: { noTools: true, system: BOARD_SYSTEM }
  });
}

MailApp.handlers = { redraft: (page, instruction) => queueLetterDraft(page, instruction) };

BoardApp.handlers = {
  add: async text => {
    if ( !game.user.isGM ) return game.socket.emit(SOCKET, { type: "boardAdd", userId: game.user.id, text });
    const problem = await addClue(game.user, text);
    if ( problem ) ui.notifications.warn(`Quadro: ${problem}`);
  },
  remove: async clueId => {
    if ( !game.user.isGM ) return game.socket.emit(SOCKET, { type: "boardRemove", userId: game.user.id, clueId });
    const problem = await removeClue(game.user, clueId);
    if ( problem ) ui.notifications.warn(`Quadro: ${problem}`);
  },
  analyze: () => {
    if ( !game.user.isGM ) {
      game.socket.emit(SOCKET, { type: "boardAnalyze", userId: game.user.id });
      return ui.notifications.info("🔎 Pedido de análise enviado. Ela aparece no quadro.");
    }
    queueBoardAnalysis(game.user).catch(reportError);
  }
};

// Anything Foundry complained about while a tool ran also goes to the bridge window, for troubleshooting.
Hooks.on("claudeGM.toolNotices", (tool, notices) => remoteLog(`avisos do Foundry em ${tool}: ${notices.join(" | ").slice(0, 600)}`));

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
    label: "Perguntar ao Claude",
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
  return `<details class="claude-gm-steps"${open ? " open" : ""}><summary>${game.i18n.localize("CLAUDEGM.Actions")} (${steps.length})</summary><ul>${items}</ul></details>`;
}
