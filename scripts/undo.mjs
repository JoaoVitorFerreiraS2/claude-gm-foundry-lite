/**
 * Undo journal: every change Claude makes is recorded under the request ("turn") that caused it,
 * so /claude desfazer can revert the last request. Saved in this browser (per world) so it survives a reload.
 */
const { deepClone, escapeHTML, fromUuid, getDocumentClass } = foundry.utils;

const MAX_TURNS = 30;
let turns = [];
let current = null;

/** Handlers for operation kinds that live outside the browser (e.g. Obsidian notes restored by the bridge). */
const externalHandlers = {};
export function registerUndoHandler(kind, fn) {
  externalHandlers[kind] = fn;
}

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
 * Kinds: create, update, delete, status, time, irreversible, or one registered with registerUndoHandler (note).
 * @param {{kind: string, label: string, uuid?: string, before?: object, data?: object, documentName?: string,
 *          parentUuid?: string}} op
 */
export function record(op) {
  if ( current ) current.ops.push(op);
  else {
    turns.push({ label: `Claude Code (terminal): ${op.label}`, ops: [op], at: Date.now() });
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
  const verbs = { create: "Excluir o que foi criado", update: "Restaurar valores", delete: "Recriar o que foi excluído",
    status: "Reverter condição", time: "Voltar o relógio", note: "Restaurar nota do Obsidian", irreversible: "Não dá para desfazer" };
  const items = turn.ops.map(op => `<li><b>${verbs[op.kind]}:</b> ${escapeHTML(op.label)}</li>`).join("");
  return `<p>Pedido: <i>${escapeHTML(turn.label)}</i></p><ul>${items}</ul>`;
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
          report.push(`excluído: ${op.label}`);
          break;
        }
        case "update": {
          const doc = await fromUuid(op.uuid);
          if ( !doc ) throw new Error("documento não existe mais");
          await doc.update(op.before);
          report.push(`restaurado: ${op.label}`);
          break;
        }
        case "delete": {
          const parent = op.parentUuid ? await fromUuid(op.parentUuid) : null;
          await getDocumentClass(op.documentName).create(op.data, { keepId: true, parent });
          report.push(`recriado: ${op.label}`);
          break;
        }
        case "status": {
          const doc = await fromUuid(op.uuid);
          if ( !doc ) throw new Error("ator não existe mais");
          await doc.toggleStatusEffect(op.statusId, { active: !op.active });
          report.push(`revertido: ${op.label}`);
          break;
        }
        case "time": {
          const SC = globalThis.SimpleCalendar?.api;
          if ( SC ) SC.changeDate(op.interval);
          else {
            const i = op.interval;
            await game.time.advance(((i.day ?? 0) * 86400) + ((i.hour ?? 0) * 3600) + ((i.minute ?? 0) * 60));
          }
          report.push(`revertido: ${op.label}`);
          break;
        }
        case "irreversible":
          report.push(`não desfeito: ${op.label}`);
          break;
        default:
          if ( !externalHandlers[op.kind] ) throw new Error(`tipo desconhecido: ${op.kind}`);
          report.push(await externalHandlers[op.kind](op));
      }
    } catch (err) {
      report.push(`falhou (${op.label}): ${err.message}`);
    }
  }
  return report;
}
