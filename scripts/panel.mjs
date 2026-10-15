/**
 * A conversation window for Claude, separate from the chat log.
 * It can hold a "focused" document (from a sheet header button or the token HUD) with quick actions for it.
 * main.mjs wires the actions through ClaudePanel.handlers to avoid circular imports.
 */
const { ApplicationV2 } = foundry.applications.api;
const { escapeHTML } = foundry.utils;

const MAX_ENTRIES = 80;

/** Quick actions offered for the focused document, by document type. */
const QUICK_ACTIONS = {
  Actor: [
    ["Descrever", "Descreva este personagem como eu leria em voz alta aos jogadores (aparência, postura, primeira impressão)."],
    ["Dar falas", "Escreva 5 falas curtas para este NPC, no tom e sotaque dele, para eu usar na sessão."],
    ["Ajustar ao grupo", "Ajuste este NPC para ser um desafio adequado ao grupo atual (party_info): explique o que mudaria e aplique depois da minha aprovação."],
    ["Melhorar biografia", "Melhore a biografia deste personagem mantendo o que já existe e o que as notas da campanha dizem sobre ele."]
  ],
  Item: [
    ["Melhorar descrição", "Melhore a descrição deste item, com mais sabor e sem mudar as regras."],
    ["Equilibrar", "Avalie se este item está equilibrado para o nível do grupo e sugira ajustes."]
  ],
  JournalEntry: [
    ["Melhorar texto", "Melhore o texto deste diário, mantendo os fatos, com melhor formatação e ritmo."],
    ["Resumir", "Resuma este diário em tópicos curtos para eu consultar durante a sessão."],
    ["Versão dos jogadores", "Crie uma versão deste diário para os jogadores, sem segredos do Mestre, visível para todos."]
  ],
  Scene: [
    ["Descrever cena", "Descreva esta cena em voz alta para os jogadores ao entrarem nela."],
    ["Cena viva", "Dê vida a esta cena: clima, luzes, música ambiente e uma descrição para eu ler."]
  ]
};
QUICK_ACTIONS.JournalEntryPage = QUICK_ACTIONS.JournalEntry;
QUICK_ACTIONS.Token = QUICK_ACTIONS.Actor;

const storageKey = () => `claude-gm.${game.world.id}.panel`;

export class ClaudePanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "claude-gm-panel",
    classes: ["claude-gm-panel"],
    tag: "section",
    window: { title: "Claude GM", icon: "fa-solid fa-robot", resizable: true },
    position: { width: 460, height: 640 },
    actions: {
      send: ClaudePanel.#onSend,
      stop: () => ClaudePanel.handlers.stop?.(),
      undo: () => ClaudePanel.handlers.submit?.("desfazer"),
      reset: () => ClaudePanel.handlers.submit?.("reset"),
      clearFocus: () => ClaudePanel.focus(null),
      quick: (event, target) => ClaudePanel.handlers.submit?.(target.dataset.prompt),
      clearLog: () => {
        ClaudePanel.entries = [];
        ClaudePanel.save();
        ClaudePanel.refresh();
      }
    }
  };

  /** @type {{submit?: (text: string) => void, stop?: () => void, isBusy?: () => boolean}} */
  static handlers = {};

  /** Conversation shown in the panel: {role: "user"|"claude", html}. Saved per world in this browser. */
  static entries = [];

  /** Focused document: {uuid, name, documentName}. */
  static focused = null;

  static #draft = "";

  static load() {
    try { this.entries = JSON.parse(localStorage.getItem(storageKey()) ?? "[]"); } catch { this.entries = []; }
  }

  static save() {
    this.entries = this.entries.slice(-MAX_ENTRIES);
    try { localStorage.setItem(storageKey(), JSON.stringify(this.entries)); } catch { /* quota: keep in memory */ }
  }

  static get instance() {
    return foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
  }

  static toggle() {
    const existing = this.instance;
    if ( existing ) return existing.close();
    return new this().render({ force: true });
  }

  /** Focus a document (or null to clear) and make sure the panel is open. */
  static focus(doc) {
    this.focused = doc ? { uuid: doc.uuid, name: doc.name ?? doc.id, documentName: doc.documentName } : null;
    if ( this.instance ) this.refresh();
    else if ( doc ) new this().render({ force: true });
  }

  /** Re-render if open (called whenever the conversation changes). */
  static refresh() {
    this.save();
    this.instance?.render();
  }

  /** @override */
  async _renderHTML() {
    const busy = ClaudePanel.handlers.isBusy?.() ?? false;
    const entries = ClaudePanel.entries.map(e =>
      `<div class="claude-gm-entry ${e.role}">${e.role === "user" ? `<blockquote class="claude-gm-request">${e.html}</blockquote>` : e.html}</div>`
    ).join("") || `<p class="claude-gm-empty">Peça algo sobre o mundo. Ex.: "monte um encontro médio de mortos-vivos" ou abra uma ficha e clique no robô do cabeçalho.</p>`;
    const f = ClaudePanel.focused;
    const quick = f ? (QUICK_ACTIONS[f.documentName] ?? []).map(([label, prompt]) =>
      `<button type="button" data-action="quick" data-prompt="${escapeHTML(prompt)}">${escapeHTML(label)}</button>`).join("") : "";
    const focus = f ? `
      <div class="claude-gm-focus">
        <span><i class="fa-solid fa-crosshairs"></i> ${escapeHTML(f.documentName)}: <b>${escapeHTML(f.name)}</b></span>
        <a data-action="clearFocus" data-tooltip="Tirar o foco"><i class="fa-solid fa-xmark"></i></a>
        <div class="claude-gm-quick">${quick}</div>
      </div>` : "";
    return `
      <div class="claude-gm claude-gm-log">${entries}</div>
      ${focus}
      <div class="claude-gm-input">
        <textarea name="prompt" rows="3" placeholder="Enter envia, Shift+Enter quebra linha. Comece com ! para usar o modelo mais forte, ? para o rápido."></textarea>
        <div class="claude-gm-buttons">
          <button type="button" data-action="send"><i class="fa-solid fa-paper-plane"></i> ${busy ? "Pôr na fila" : "Enviar"}</button>
          <button type="button" data-action="stop" ${busy ? "" : "disabled"}><i class="fa-solid fa-stop"></i> Parar</button>
          <button type="button" data-action="undo" ${busy ? "disabled" : ""} data-tooltip="Desfazer o último pedido"><i class="fa-solid fa-rotate-left"></i></button>
          <button type="button" data-action="reset" ${busy ? "disabled" : ""} data-tooltip="Nova conversa (o Claude esquece o contexto)"><i class="fa-solid fa-broom"></i></button>
          <button type="button" data-action="clearLog" ${busy ? "disabled" : ""} data-tooltip="Limpar esta janela"><i class="fa-solid fa-eraser"></i></button>
        </div>
      </div>`;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.innerHTML = result;
    const textarea = content.querySelector("textarea");
    textarea.value = ClaudePanel.#draft;
    textarea.addEventListener("input", () => { ClaudePanel.#draft = textarea.value; });
    textarea.addEventListener("keydown", event => {
      if ( (event.key !== "Enter") || event.shiftKey || event.isComposing ) return;
      event.preventDefault();
      ClaudePanel.#onSend.call(this);
    });
    const log = content.querySelector(".claude-gm-log");
    log.scrollTop = log.scrollHeight;
    textarea.focus();
  }

  static #onSend() {
    const text = ClaudePanel.#draft.trim();
    if ( !text ) return; // while Claude is busy the request is queued
    ClaudePanel.#draft = "";
    ClaudePanel.handlers.submit?.(text);
  }
}
