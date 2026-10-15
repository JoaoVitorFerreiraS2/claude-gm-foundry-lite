/**
 * Undo journal: every change Claude makes is recorded under the request ("turn") that caused it,
 * so /claude undo can revert the last request. Saved in this browser (per world) so it survives a reload.
 */
import { t } from "./i18n.mjs";

const { deepClone, escapeHTML, fromUuid } = foundry.utils;

const MAX_TURNS = 30;
let turns = [];
let current = null;

const storageKey = () => `claude-gm.${game.world.id}.undo`;

export function loadUndo() {
  try {
    turns = JSON.parse(localStorage.getItem(storageKey()) ?? "[]");
  } catch {
    turns = [];
  }
}

function save() {
  // Big snapshots can exceed the browser quota: drop the oldest turns until it fits.
  while ( turns.length ) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(turns));
      return;
    } catch {
      turns.shift();
    }
  }
  try { localStorage.removeItem(storageKey()); } catch { /* storage unavailable */ }
}

/** Start grouping changes under one GM request. */
export function beginTurn(label) {
  current = { label, ops: [], at: Date.now() };
}

export function endTurn() {
  if ( current?.ops.length ) {
    turns.push(current);
    if ( turns.length > MAX_TURNS ) turns.shift();
    save();
  }
  current = null;
}

/**
 * Record one reversible operation.
 * Kinds: create, update.
 * @param {{kind: string, label: string, uuid?: string, before?: object}} op
 */
export function record(op) {
  if ( current ) current.ops.push(op);
  else {
    turns.push({ label: op.label, ops: [op], at: Date.now() });
    save();
  }
}

export const undoCount = () => turns.length;

/** Forget the whole undo history (e.g. after tests, or when the recorded changes no longer make sense). */
export function clearUndo() {
  turns = [];
  save();
}

/** Capture the current values of the paths an update is about to change. */
export function snapshotBefore(doc, flatChanges) {
  const before = {};
  for ( const key of Object.keys(flatChanges) ) {
    const parts = key.split(".");
    if ( parts.slice(0, -1).some(part => part.startsWith("-=")) ) continue;
    // A deletion ("a.-=b"): remember the deleted value so undo can put it back.
    if ( parts.at(-1).startsWith("-=") ) {
      const original = [...parts.slice(0, -1), parts.at(-1).slice(2)].join(".");
      const value = foundry.utils.getProperty(doc._source, original);
      if ( value !== undefined ) before[original] = deepClone(value);
      continue;
    }
    const value = foundry.utils.getProperty(doc._source, key);
    if ( value !== undefined ) before[key] = deepClone(value);
    // The key did not exist: undoing must remove it ("a.b.-=c": null).
    else before[[...parts.slice(0, -1), `-=${parts.at(-1)}`].join(".")] = null;
  }
  return before;
}

/** Describe the last turn as HTML, for the confirmation dialog. */
export function describeLast() {
  const turn = turns.at(-1);
  if ( !turn ) return null;
  const verbs = { create: t("Undo.VerbCreate"), update: t("Undo.VerbUpdate") };
  const items = turn.ops.map(op => `<li><b>${verbs[op.kind] ?? op.kind}:</b> ${escapeHTML(op.label)}</li>`).join("");
  return `<p>${t("Undo.Request", { label: `<i>${escapeHTML(turn.label)}</i>` })}</p><ul>${items}</ul>`;
}

/** Revert the last turn, newest operation first. Returns a short report. */
export async function undoLast() {
  const turn = turns.pop();
  if ( !turn ) return [];
  save();
  const report = [];
  for ( const op of [...turn.ops].reverse() ) {
    try {
      switch ( op.kind ) {
        case "create": {
          const doc = await fromUuid(op.uuid);
          if ( doc ) await doc.delete();
          report.push(t("Undo.Deleted", { label: op.label }));
          break;
        }
        case "update": {
          const doc = await fromUuid(op.uuid);
          if ( !doc ) throw new Error(t("Undo.DocGone"));
          await doc.update(op.before);
          report.push(t("Undo.Restored", { label: op.label }));
          break;
        }
        default:
          throw new Error(t("Undo.UnknownKind", { kind: op.kind }));
      }
    } catch (err) {
      report.push(t("Undo.Failed", { label: op.label, message: err.message }));
    }
  }
  return report;
}
