/**
 * A conversation window for Claude, separate from the chat log.
 * It can hold a "focused" document (from a sheet header button or the token HUD) with quick actions for it.
 * main.mjs wires the actions through ClaudePanel.handlers to avoid circular imports.
 */
import { t } from "./i18n.mjs";

const { ApplicationV2 } = foundry.applications.api;
const { escapeHTML } = foundry.utils;

const MAX_ENTRIES = 80;

/** Quick actions offered for the focused document, by document type: [label, prompt] pairs (localized). */
function quickActions(documentName) {
  const actor = () => [
    [t("Panel.Quick.Actor.Describe"), t("Panel.Quick.Actor.DescribePrompt")],
    [t("Panel.Quick.Actor.Lines"), t("Panel.Quick.Actor.LinesPrompt")],
    [t("Panel.Quick.Actor.Scale"), t("Panel.Quick.Actor.ScalePrompt")],
    [t("Panel.Quick.Actor.Biography"), t("Panel.Quick.Actor.BiographyPrompt")]
  ];
  const journal = () => [
    [t("Panel.Quick.Journal.Improve"), t("Panel.Quick.Journal.ImprovePrompt")],
    [t("Panel.Quick.Journal.Summarize"), t("Panel.Quick.Journal.SummarizePrompt")],
    [t("Panel.Quick.Journal.PlayerVersion"), t("Panel.Quick.Journal.PlayerVersionPrompt")]
  ];
  switch ( documentName ) {
    case "Actor":
    case "Token":
      return actor();
    case "Item":
      return [
        [t("Panel.Quick.Item.Improve"), t("Panel.Quick.Item.ImprovePrompt")],
        [t("Panel.Quick.Item.Balance"), t("Panel.Quick.Item.BalancePrompt")]
      ];
    case "JournalEntry":
    case "JournalEntryPage":
      return journal();
    case "Scene":
      return [
        [t("Panel.Quick.Scene.Describe"), t("Panel.Quick.Scene.DescribePrompt")],
        [t("Panel.Quick.Scene.Ideas"), t("Panel.Quick.Scene.IdeasPrompt")]
      ];
    default:
      return [];
  }
}

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
      undo: () => ClaudePanel.handlers.submit?.("undo"),
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
    ).join("") || `<p class="claude-gm-empty">${t("Panel.Empty")}</p>`;
    const f = ClaudePanel.focused;
    const quick = f ? quickActions(f.documentName).map(([label, prompt]) =>
      `<button type="button" data-action="quick" data-prompt="${escapeHTML(prompt)}">${escapeHTML(label)}</button>`).join("") : "";
    const focus = f ? `
      <div class="claude-gm-focus">
        <span><i class="fa-solid fa-crosshairs"></i> ${escapeHTML(f.documentName)}: <b>${escapeHTML(f.name)}</b></span>
        <a data-action="clearFocus" data-tooltip="${escapeHTML(t("Panel.ClearFocus"))}"><i class="fa-solid fa-xmark"></i></a>
        <div class="claude-gm-quick">${quick}</div>
      </div>` : "";
    return `
      <div class="claude-gm claude-gm-log">${entries}</div>
      ${focus}
      <div class="claude-gm-input">
        <textarea name="prompt" rows="3" placeholder="${escapeHTML(t("Panel.Placeholder"))}"></textarea>
        <div class="claude-gm-buttons">
          <button type="button" data-action="send"><i class="fa-solid fa-paper-plane"></i> ${busy ? t("Panel.Queue") : t("Panel.Send")}</button>
          <button type="button" data-action="stop" ${busy ? "" : "disabled"}><i class="fa-solid fa-stop"></i> ${t("Panel.Stop")}</button>
          <button type="button" data-action="undo" ${busy ? "disabled" : ""} data-tooltip="${escapeHTML(t("Panel.UndoTip"))}"><i class="fa-solid fa-rotate-left"></i></button>
          <button type="button" data-action="reset" ${busy ? "disabled" : ""} data-tooltip="${escapeHTML(t("Panel.ResetTip"))}"><i class="fa-solid fa-broom"></i></button>
          <button type="button" data-action="clearLog" ${busy ? "disabled" : ""} data-tooltip="${escapeHTML(t("Panel.ClearLogTip"))}"><i class="fa-solid fa-eraser"></i></button>
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
