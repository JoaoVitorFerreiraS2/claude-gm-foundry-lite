/**
 * Tools that Claude can call to read and change the current world.
 * Each tool has an Anthropic tool definition and a `run(input)` that returns a JSON-serialisable result.
 * Throwing from `run` sends an error tool_result back to Claude.
 */
import { MODULE_ID } from "./constants.mjs";
import { record, snapshotBefore } from "./undo.mjs";
import { t } from "./i18n.mjs";

const { escapeHTML, flattenObject, getProperty, fromUuid, getDocumentClass } = foundry.utils;

/**
 * Can this user read the document through Claude? GMs and GM-run requests (no user) read everything.
 * Players only read what they OWN (their own characters and everything inside them), journals the GM shared with them,
 * and rules and item/spell descriptions from compendiums. Never monsters, other characters or scenes: that would be metagame.
 */
const PLAYER_PACK_TYPES = new Set(["JournalEntry", "JournalEntryPage", "Item"]);
function canSee(doc, user) {
  if ( !user || user.isGM ) return true;
  if ( doc.pack ) {
    return PLAYER_PACK_TYPES.has(doc.documentName) && (game.packs.get(doc.pack)?.testUserPermission(user, "OBSERVER") ?? false);
  }
  // Journals the GM shared with the player (they can already open them in Foundry).
  if ( ["JournalEntry", "JournalEntryPage"].includes(doc.documentName) ) return doc.testUserPermission(user, "OBSERVER");
  return doc.testUserPermission(user, "OWNER");
}

/** The only tools a player request gets: their own sheets, journals shared with them, and the rules. */
const PLAYER_TOOLS = new Set(["get_my_characters", "get_document", "search_compendiums", "search_journal_text"]);

const docLabel = doc => `${doc.documentName} "${doc.name ?? doc.id}"`;

const WORLD_TYPES = [
  "Actor", "Item", "JournalEntry", "Scene", "Macro", "RollTable", "Playlist",
  "Folder", "User", "Combat", "Cards", "Adventure"
];
const MAX_RESULT_CHARS = 60_000;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const normalize = s => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function truncate(value) {
  const json = JSON.stringify(value);
  if ( json.length <= MAX_RESULT_CHARS ) return value;
  return {
    truncated: true,
    note: `The result had ${json.length} characters and was cut off. Use the "fields" parameter to request only the fields you need.`,
    partial: json.slice(0, MAX_RESULT_CHARS)
  };
}

async function resolve(uuid) {
  const doc = await fromUuid(uuid);
  if ( !doc ) throw new Error(`Document not found: ${uuid}`);
  return doc;
}

/** Extra index fields that help pick the right entry (dnd5e paths; missing ones are simply absent). */
const INDEX_FIELDS = {
  Actor: ["system.details.cr", "system.details.level"],
  Item: ["system.level", "system.school"]
};

function findFolder(nameOrUuid, type) {
  const n = normalize(nameOrUuid);
  return game.folders.find(f => (f.type === type) && ((f.uuid === nameOrUuid) || (normalize(f.name) === n)));
}

function summarize(doc) {
  return {
    uuid: doc.uuid,
    name: doc.name ?? null,
    type: doc.type ?? null,
    folder: doc.folder?.name ?? null
  };
}

/** Ask the GM to approve. `always` forces the dialog even when the confirm setting is off. */
export async function approve(title, bodyHTML, {always=false}={}) {
  if ( !always && !game.settings.get(MODULE_ID, "confirmChanges") ) return true;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: `${t("Confirm.Title")}: ${title}` },
    content: `<div class="claude-gm-confirm">${bodyHTML}</div>`,
    position: { width: 560 },
    rejectClose: false,
    modal: true
  });
  if ( ok !== true ) throw new Error(t("Confirm.Declined"));
  return true;
}

/** Chat visibility option for Roll#toMessage / RollTable#draw in both v14 (messageMode) and v13 (rollMode). */
const visibility = gmOnly => (CONFIG.ChatMessage?.modes
  ? { messageMode: gmOnly ? "gm" : "public" }
  : { rollMode: gmOnly ? "gmroll" : "publicroll" });

/** Accept data with dot-path keys too ({"system.x": 1}) — creation does not expand them by itself. */
const expand = data => foundry.utils.expandObject(data ?? {});

/** Resolve a UUID to an Actor, accepting Token UUIDs (uses the token's actor). */
async function resolveActor(uuid) {
  const doc = await resolve(uuid);
  const actor = doc.documentName === "Actor" ? doc : doc.actor;
  if ( !actor ) throw new Error(`${uuid} is neither an actor nor a token with an actor.`);
  return actor;
}

const htmlToText = (html, max=800) => {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return div.textContent.replace(/\s+/g, " ").trim().slice(0, max);
};


/** One collapsible block per document in approval previews; open when it is the only one. */
const section = (title, body, open) => `<details${open ? " open" : ""}><summary>${title}</summary>${body}</details>`;

const pre = value => `<pre>${escapeHTML(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>`;

/**
 * Foundry keeps the token's name apart from the actor's. When an actor is renamed and its prototype token still
 * carries the old actor name (or no explicit name was asked for), rename the token too, so it shows up right on the map.
 * @param {object} data      Expanded creation or update data (mutated).
 * @param {string} oldName   The actor's current (or source) name.
 */
function syncPrototypeTokenName(data, oldName) {
  const newName = data?.name;
  if ( !newName || (newName === oldName) ) return data;
  if ( foundry.utils.getProperty(data, "prototypeToken.name") !== undefined ) return data;
  foundry.utils.setProperty(data, "prototypeToken.name", newName);
  return data;
}

/**
 * dnd5e item activities must be an object keyed by 16-character ids, each with that _id and a known type.
 * Claude often sends an array or made-up ids; fix the shape, and fail clearly on unknown types
 * (dnd5e would silently drop them).
 * @param {object} data  Expanded creation or update data (mutated).
 */
const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;
function normalizeActivities(data) {
  const acts = data?.system?.activities;
  const types = CONFIG.DND5E?.activityTypes;
  if ( !acts || (typeof acts !== "object") || !types ) return data;
  const entries = Array.isArray(acts) ? acts.map(a => [null, a]) : Object.entries(acts);
  const out = {};
  for ( const [key, act] of entries ) {
    if ( key?.startsWith("-=") ) { out[key] = act; continue; } // deletion of an activity
    if ( !act || (typeof act !== "object") ) continue;
    if ( act.type && !types[act.type] ) {
      throw new Error(`Activity with invalid type "${act.type}". Valid types: ${Object.keys(types).join(", ")}.`);
    }
    const id = ID_PATTERN.test(act._id ?? "") ? act._id : (ID_PATTERN.test(key ?? "") ? key : foundry.utils.randomID());
    out[id] = { ...act, _id: id };
  }
  data.system.activities = out;
  return data;
}

/** Compact description of a value's structure (keys and sample values), for data stored outside a schema. */
function shapeOf(value, depth=0) {
  if ( Array.isArray(value) ) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if ( value && (typeof value === "object") ) {
    if ( depth > 4 ) return "{…}";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return typeof value === "string" ? `string (e.g. "${value.slice(0, 40)}")` : `${typeof value} (e.g. ${JSON.stringify(value)})`;
}

/** Walk a DataModel schema into {path: description} pairs. */
function describeField(field, path, out, depth=0) {
  if ( Object.keys(out).length >= 800 || depth > 8 ) return;
  const name = field.constructor.name;
  if ( field.fields && (name !== "TypeDataField") ) {
    for ( const [k, f] of Object.entries(field.fields) ) describeField(f, path ? `${path}.${k}` : k, out, depth + 1);
    return;
  }
  if ( field.element?.documentName ) {
    out[path] = `EmbeddedCollection<${field.element.documentName}> (create with parent_uuid)`;
    return;
  }
  if ( field.element ) {
    describeField(field.element, `${path}[]`, out, depth + 1);
    return;
  }
  let desc = name;
  const choices = typeof field.choices === "function" ? null : field.choices;
  if ( choices ) {
    const keys = Array.isArray(choices) ? choices : Object.keys(choices);
    desc += ` choices=[${keys.slice(0, 40).join(", ")}${keys.length > 40 ? ", …" : ""}]`;
  }
  if ( (field.initial !== undefined) && (typeof field.initial !== "function") && (typeof field.initial !== "object") ) {
    desc += ` initial=${JSON.stringify(field.initial)}`;
  }
  out[path] = desc;
}

/* -------------------------------------------- */
/*  Tool definitions                            */
/* -------------------------------------------- */

const TOOLS = {

  get_my_characters: {
    description: "Lists the characters owned by the player who is asking (name, uuid, class, level). Start here, then use get_document on the uuid with fields.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    playerOnly: true,
    async run(_input, ctx) {
      if ( !ctx.user ) throw new Error("Only for player questions.");
      const owned = game.actors.filter(a => a.testUserPermission(ctx.user, "OWNER"));
      return owned.map(a => ({
        uuid: a.uuid, name: a.name, type: a.type, assigned: ctx.user.character?.id === a.id,
        level: a.system?.details?.level ?? null,
        classes: Object.values(a.classes ?? {}).map(c => `${c.name} ${c.system?.levels ?? ""}`.trim())
      }));
    }
  },

  get_world_overview: {
    description: "Overview of the current world: game system, Foundry version, active scene, users, combat and document counts by type. Use it at the start when you need to get your bearings.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const counts = {};
      for ( const type of WORLD_TYPES ) counts[type] = game.collections.get(type)?.size ?? 0;
      const scene = game.scenes.active;
      return {
        world: { id: game.world.id, title: game.world.title },
        system: { id: game.system.id, title: game.system.title, version: game.system.version },
        foundryVersion: game.version,
        activeScene: scene ? summarize(scene) : null,
        viewedScene: canvas?.scene ? summarize(canvas.scene) : null,
        users: game.users.map(u => ({
          id: u.id, name: u.name, isGM: u.isGM, active: u.active, character: u.character?.uuid ?? null
        })),
        combat: game.combat ? { uuid: game.combat.uuid, round: game.combat.round, turn: game.combat.turn } : null,
        documentTypes: Object.fromEntries(WORLD_TYPES.map(type => [type, game.documentTypes?.[type] ?? []])),
        counts
      };
    }
  },

  search_documents: {
    description: "Searches world documents by type and, optionally, by part of the name (ignores accents and case), system subtype or folder. Returns uuid, name, type and folder.",
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: WORLD_TYPES },
        query: { type: "string", description: "Part of the name to look for." },
        subtype: { type: "string", description: "System subtype, e.g. npc, character, weapon, spell." },
        folder: { type: "string", description: "Part of the folder name." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 50." }
      },
      required: ["document_type"],
      additionalProperties: false
    },
    async run({ document_type, query, subtype, folder, limit=50 }, ctx) {
      const collection = game.collections.get(document_type);
      if ( !collection ) throw new Error(`Type has no world collection: ${document_type}`);
      const q = normalize(query);
      const f = normalize(folder);
      const matches = collection.filter(d => {
        if ( !canSee(d, ctx.user) ) return false;
        if ( q && !normalize(d.name).includes(q) ) return false;
        if ( subtype && (d.type !== subtype) ) return false;
        if ( f && !normalize(d.folder?.name).includes(f) ) return false;
        return true;
      });
      return { total: matches.length, results: matches.slice(0, limit).map(summarize) };
    }
  },

  list_compendiums: {
    description: "Lists the available compendiums (from the system, modules and the world) with id, name, document type and number of entries.",
    input_schema: {
      type: "object",
      properties: { document_type: { type: "string", description: "Filter by type, e.g. Actor, Item, JournalEntry." } },
      additionalProperties: false
    },
    async run({ document_type }, ctx) {
      const packs = game.packs.filter(p => (!document_type || (p.documentName === document_type))
        && (!ctx.user || p.testUserPermission(ctx.user, "OBSERVER")));
      return packs.map(p => ({
        id: p.collection,
        label: p.metadata.label,
        type: p.documentName,
        package: p.metadata.packageName,
        size: p.index.size
      }));
    }
  },

  search_compendiums: {
    description: "Searches compendium entries (e.g. SRD monsters, spells, items) by part of the name (ignores accents), subtype or compendium. Returns uuid, name, type and compendium; use get_document on the uuid to see the full sheet and import_from_compendium to bring it into the world.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the name, e.g. veteran, fireball." },
        document_type: { type: "string", description: "Actor, Item, JournalEntry, RollTable, Scene, Macro..." },
        subtype: { type: "string", description: "System subtype, e.g. npc, spell, weapon." },
        packs: { type: "array", items: { type: "string" }, description: "Compendium ids to restrict the search." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 30." }
      },
      additionalProperties: false
    },
    async run({ query, document_type, subtype, packs, limit=30 }, ctx) {
      if ( !query && !subtype ) throw new Error("Provide query or subtype.");
      const q = normalize(query);
      const results = [];
      let total = 0;
      for ( const pack of game.packs ) {
        if ( document_type && (pack.documentName !== document_type) ) continue;
        if ( packs?.length && !packs.includes(pack.collection) ) continue;
        if ( ctx.user && !(PLAYER_PACK_TYPES.has(pack.documentName) && pack.testUserPermission(ctx.user, "OBSERVER")) ) continue;
        const index = await pack.getIndex({ fields: INDEX_FIELDS[pack.documentName] ?? [] });
        for ( const entry of index ) {
          if ( q && !normalize(entry.name).includes(q) ) continue;
          if ( subtype && (entry.type !== subtype) ) continue;
          total++;
          if ( results.length >= limit ) continue;
          const extra = {};
          for ( const f of INDEX_FIELDS[pack.documentName] ?? [] ) {
            const v = getProperty(entry, f);
            if ( v !== undefined ) extra[f.split(".").pop()] = v;
          }
          results.push({
            uuid: entry.uuid ?? `Compendium.${pack.collection}.${pack.documentName}.${entry._id}`,
            name: entry.name,
            type: entry.type ?? null,
            pack: pack.metadata.label,
            ...extra
          });
        }
      }
      return { total, results };
    }
  },

  import_from_compendium: {
    description: "Brings compendium documents into the world, optionally already modified. Use it to create things based on existing content (e.g. an NPC based on the Veteran sheet, with another name and biography) instead of building the sheet from scratch. With parent_uuid, the item/effect is added to an actor. changes uses dot paths, as in update_documents.",
    input_schema: {
      type: "object",
      properties: {
        imports: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              uuid: { type: "string", description: "UUID of the compendium entry (Compendium....)." },
              changes: { type: "object", description: "Changes applied before creating, e.g. {\"name\": \"Captain Dorn\"}." },
              folder: { type: "string", description: "Name or UUID of an existing folder for the document." },
              parent_uuid: { type: "string", description: "Actor (or other document) that will receive the item." }
            },
            required: ["uuid"]
          }
        }
      },
      required: ["imports"],
      additionalProperties: false
    },
    async run({ imports }) {
      const sources = await Promise.all(imports.map(i => resolve(i.uuid)));
      sources.forEach((s, i) => {
        if ( !s.pack ) throw new Error(`${imports[i].uuid} is not a compendium entry; use create_documents.`);
      });
      const preview = imports.map((imp, i) => {
        const target = imp.parent_uuid ? ` → ${escapeHTML(imp.parent_uuid)}` : "";
        const changes = imp.changes ? pre(flattenObject(imp.changes)) : "";
        return changes
          ? section(`${escapeHTML(sources[i].documentName)}: ${escapeHTML(sources[i].name)}${target}`, changes, imports.length === 1)
          : `<p><b>${escapeHTML(sources[i].documentName)}: ${escapeHTML(sources[i].name)}${target}</b></p>`;
      }).join("");
      await approve(t("Confirm.Import", { count: imports.length }), preview);

      const results = [];
      for ( const [i, imp] of imports.entries() ) {
        const source = sources[i];
        let created;
        if ( imp.parent_uuid ) {
          const parent = await resolve(imp.parent_uuid);
          const data = source.toObject();
          delete data._id;
          foundry.utils.setProperty(data, "_stats.compendiumSource", source.uuid);
          if ( imp.changes ) foundry.utils.mergeObject(data, normalizeActivities(foundry.utils.expandObject(imp.changes)));
          [created] = await parent.createEmbeddedDocuments(source.documentName, [data]);
        } else {
          const collection = game.collections.get(source.documentName);
          if ( !collection ) throw new Error(`${source.documentName} cannot be imported directly into the world.`);
          const data = collection.fromCompendium(source);
          if ( imp.changes ) {
            const changes = foundry.utils.expandObject(imp.changes);
            if ( source.documentName === "Actor" ) syncPrototypeTokenName(changes, source.name);
            foundry.utils.mergeObject(data, changes);
          }
          if ( imp.folder ) {
            const folder = findFolder(imp.folder, source.documentName);
            if ( !folder ) throw new Error(`Folder "${imp.folder}" of ${source.documentName} does not exist; create it first with create_documents.`);
            data.folder = folder.id;
          }
          created = await getDocumentClass(source.documentName).create(data);
        }
        if ( !created ) {
          results.push({ source: source.uuid, error: "Creation was cancelled by the system or by another module." });
          continue;
        }
        record({ kind: "create", uuid: created.uuid, label: docLabel(created) });
        const keys = Object.keys(flattenObject(imp.changes ?? {}));
        results.push({
          ...summarize(created),
          source: source.uuid,
          storedValues: Object.fromEntries(keys.map(k => [k, getProperty(created._source, k) ?? null]))
        });
      }
      return { results };
    }
  },

  get_document: {
    description: "Reads a document's data by UUID (e.g. Actor.abc, Actor.abc.Item.def, Scene.x.Token.y, Compendium...). Embedded collections come summarized (uuid/name/type) unless include_embedded is true. Use fields to read only some paths (e.g. system.attributes.hp); in that mode the values computed by the system (derived), such as AC, max HP and modifiers, come back too.",
    input_schema: {
      type: "object",
      properties: {
        uuid: { type: "string" },
        fields: { type: "array", items: { type: "string" }, description: "Dot paths to return." },
        include_embedded: { type: "boolean" }
      },
      required: ["uuid"],
      additionalProperties: false
    },
    async run({ uuid, fields, include_embedded=false }, ctx) {
      const doc = await resolve(uuid);
      if ( !canSee(doc, ctx.user) ) throw new Error("This player does not have permission to see that document.");
      const data = doc.toObject();
      if ( fields?.length ) {
        // Source values are what update_documents changes; derived values are what the sheet shows
        // (e.g. dnd5e computes AC, max HP, modifiers and save DCs that are not stored).
        const values = {};
        const derived = {};
        for ( const p of fields ) {
          values[p] = getProperty(data, p) ?? null;
          const live = getProperty(doc, p);
          if ( (live !== undefined) && (typeof live !== "function")
            && (JSON.stringify(live) !== JSON.stringify(values[p])) ) derived[p] = live;
        }
        return { ...summarize(doc), values, ...(Object.keys(derived).length ? { derived } : {}) };
      }
      if ( !include_embedded ) {
        for ( const [embeddedName, key] of Object.entries(doc.constructor.metadata.embedded ?? {}) ) {
          const coll = doc.getEmbeddedCollection?.(embeddedName);
          if ( !coll || !Array.isArray(data[key]) ) continue;
          const named = coll.contents.some(d => d.name);
          data[key] = named
            ? { count: coll.size, items: coll.contents.slice(0, 150).map(d => ({ uuid: d.uuid, name: d.name ?? null, type: d.type ?? null })) }
            : { count: coll.size };
        }
      }
      return truncate({ uuid: doc.uuid, documentName: doc.documentName, data });
    }
  },

  describe_schema: {
    description: "Lists the fields (path -> type, choices and initial value) of a document type and, if given, of the subtype (e.g. Actor/npc, Item/weapon, or module-added types such as Actor/<module-id>.<type>). For module types that keep their data in flags, it also shows the flags structure of an existing sheet. Use it before creating documents or when you do not know a field's path.",
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", description: "E.g. Actor, Item, JournalEntryPage, Token, ActiveEffect, Scene." },
        subtype: { type: "string" }
      },
      required: ["document_type"],
      additionalProperties: false
    },
    async run({ document_type, subtype }) {
      const cls = getDocumentClass(document_type);
      if ( !cls ) throw new Error(`Unknown document type: ${document_type}`);
      const fields = {};
      describeField(cls.schema, "", fields);
      let flagsExample;
      if ( subtype ) {
        const model = CONFIG[document_type]?.dataModels?.[subtype];
        if ( model ) describeField(model.schema, "system", fields);
        else fields.system = "no DataModel registered for this subtype";
        // Types added by modules often keep their data in flags: show the structure of an existing one.
        const example = game.collections.get(document_type)?.find(d => (d.type === subtype) && !foundry.utils.isEmpty(d.flags));
        if ( example ) flagsExample = { from: example.uuid, flags: shapeOf(example.toObject().flags) };
      }
      return {
        document_type, subtype: subtype ?? null, availableSubtypes: game.documentTypes?.[document_type] ?? [], fields,
        ...(flagsExample ? { flagsExample, note: "This type keeps its data in flags; change it with paths like flags.<module>.<field>." } : {})
      };
    }
  },

  update_documents: {
    description: "Updates one or more documents. Each item has uuid and changes (an object with dot paths, e.g. {\"system.attributes.hp.value\": 10, \"name\": \"New name\"}). To remove a key use \"-=key\": null. Returns the stored values so you can check them.",
    input_schema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { uuid: { type: "string" }, changes: { type: "object" } },
            required: ["uuid", "changes"]
          }
        }
      },
      required: ["updates"],
      additionalProperties: false
    },
    async run({ updates }) {
      const docs = await Promise.all(updates.map(u => resolve(u.uuid)));
      const preview = updates.map((u, i) => {
        const rows = Object.entries(flattenObject(u.changes)).map(([k, v]) => {
          const before = getProperty(docs[i]._source, k);
          return `<tr><td><code>${escapeHTML(k)}</code></td><td>${escapeHTML(JSON.stringify(before) ?? "—")}</td><td>${escapeHTML(JSON.stringify(v))}</td></tr>`;
        }).join("");
        return section(escapeHTML(docs[i].name ?? docs[i].uuid),
          `<table><tr><th>${t("Confirm.Field")}</th><th>${t("Confirm.Before")}</th><th>${t("Confirm.After")}</th></tr>${rows}</table>`, updates.length === 1);
      }).join("");
      await approve(t("Confirm.Update", { count: docs.length }), preview);

      const results = [];
      for ( const [i, u] of updates.entries() ) {
        const doc = docs[i];
        if ( (doc.documentName === "Item") && JSON.stringify(u.changes).includes("activities") ) {
          u.changes = normalizeActivities(foundry.utils.expandObject(u.changes));
        }
        if ( (doc.documentName === "Actor") && (doc.prototypeToken?.name === doc.name) ) {
          const expanded = foundry.utils.expandObject(u.changes);
          if ( expanded.name && (expanded.prototypeToken?.name === undefined) ) u.changes["prototypeToken.name"] = expanded.name;
        }
        const before = snapshotBefore(doc, flattenObject(u.changes));
        const changed = await doc.update(u.changes);
        if ( changed ) record({ kind: "update", uuid: doc.uuid, label: docLabel(doc), before });
        const keys = Object.keys(flattenObject(u.changes)).filter(k => !k.split(".").pop().startsWith("-="));
        results.push({
          uuid: doc.uuid,
          name: doc.name ?? null,
          applied: Boolean(changed),
          storedValues: Object.fromEntries(keys.map(k => [k, getProperty(doc._source, k) ?? null]))
        });
      }
      return { results };
    }
  },

  create_documents: {
    description: "Creates documents. For world documents give document_type (Actor, Item, JournalEntry, Scene, Macro, RollTable, Folder...) and data. For embedded documents (Item in an Actor, JournalEntryPage in a JournalEntry, Token/Tile/AmbientLight/Note in a Scene, ActiveEffect) also give parent_uuid.",
    input_schema: {
      type: "object",
      properties: {
        documents: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              document_type: { type: "string" },
              data: { type: "object" },
              parent_uuid: { type: "string" }
            },
            required: ["document_type", "data"]
          }
        }
      },
      required: ["documents"],
      additionalProperties: false
    },
    async run({ documents }) {
      // Normalize and validate everything first, so a bad entry fails the whole call before anything is created.
      for ( const d of documents ) d.data = normalizeActivities(expand(d.data));
      const preview = documents.map(d => section(
        d.parent_uuid
          ? t("Confirm.DocIn", { type: escapeHTML(d.document_type), parent: escapeHTML(d.parent_uuid), name: escapeHTML(d.data?.name ?? "") })
          : `${escapeHTML(d.document_type)}: ${escapeHTML(d.data?.name ?? "")}`,
        pre(d.data), documents.length === 1
      )).join("");
      await approve(t("Confirm.Create", { count: documents.length }), preview);

      const results = [];
      for ( const d of documents ) {
        let created;
        if ( d.parent_uuid ) {
          const parent = await resolve(d.parent_uuid);
          [created] = await parent.createEmbeddedDocuments(d.document_type, [d.data]);
        } else {
          const cls = getDocumentClass(d.document_type);
          if ( !cls ) throw new Error(`Unknown document type: ${d.document_type}`);
          created = await cls.create(d.data);
        }
        if ( created ) record({ kind: "create", uuid: created.uuid, label: docLabel(created) });
        results.push(created ? summarize(created) : { error: "Creation was cancelled by the system or by another module." });
      }
      return { results };
    }
  },


  send_chat_message: {
    description: "Posts a message to the Foundry chat (narration, description, notice). By default it goes to everyone; use gm_only to whisper to the GM only. The content is HTML.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string" },
        speaker_alias: { type: "string", description: "Name shown as the author, e.g. Narrator." },
        speaker_actor_uuid: { type: "string", description: "Speak as this actor." },
        gm_only: { type: "boolean" },
        language: { type: "string", description: "Polyglot language id (e.g. \"elvish\"). Requires speaker_actor_uuid; only those who know the language understand it." }
      },
      required: ["content"],
      additionalProperties: false
    },
    async run({ content, speaker_alias, speaker_actor_uuid, gm_only=false, language }) {
      const actor = speaker_actor_uuid ? await resolveActor(speaker_actor_uuid) : null;
      if ( language ) {
        if ( !game.modules.get("polyglot")?.active ) throw new Error("The Polyglot module is not active.");
        if ( !actor ) throw new Error("To speak in a language, provide speaker_actor_uuid.");
      }
      if ( !gm_only ) await approve(t("Confirm.PublicMessage"), foundry.utils.cleanHTML(content));
      const speaker = ChatMessage.implementation.getSpeaker({ actor, alias: speaker_alias });
      const data = {
        content,
        speaker,
        whisper: gm_only ? ChatMessage.implementation.getWhisperRecipients("GM").map(u => u.id) : []
      };
      if ( language ) {
        data.style = CONST.CHAT_MESSAGE_STYLES.IC;
        data.flags = { polyglot: { language } };
      }
      const msg = await ChatMessage.implementation.create(data);
      if ( msg ) record({ kind: "create", uuid: msg.uuid, label: t("Undo.ChatMessage") });
      return { uuid: msg?.uuid ?? null };
    }
  },


  get_chat_log: {
    description: "Reads the world chat messages (including rolls and whispers) from the last hours, in chronological order, to summarize the session or understand what happened.",
    input_schema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "How many hours back to look. Default 6." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum number of messages (the most recent). Default 400." }
      },
      additionalProperties: false
    },
    async run({ hours=6, limit=400 }) {
      const since = Date.now() - (hours * 3600_000);
      const plain = html => {
        const div = document.createElement("div");
        div.innerHTML = html ?? "";
        return div.textContent.replace(/\s+/g, " ").trim().slice(0, 800);
      };
      const messages = game.messages.contents
        .filter(m => (m.timestamp >= since) && !m.getFlag(MODULE_ID, "response"))
        .slice(-limit)
        .map(m => ({
          time: new Date(m.timestamp).toLocaleTimeString(),
          speaker: m.speaker?.alias ?? m.author?.name ?? null,
          author: m.author?.name ?? null,
          whisper: m.whisper?.length > 0,
          flavor: m.flavor ? plain(m.flavor) : undefined,
          text: plain(m.content) || undefined,
          rolls: m.rolls?.length ? m.rolls.map(r => ({ formula: r.formula, total: r.total })) : undefined
        }));
      const combat = game.combat ? {
        round: game.combat.round,
        combatants: game.combat.combatants.map(c => ({ name: c.name, defeated: c.isDefeated }))
      } : null;
      return truncate({ count: messages.length, messages, combat });
    }
  },





  search_journal_text: {
    description: "Searches for text inside the pages of all world journals (not just the name). Returns journal, page and an excerpt around each occurrence.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." }
      },
      required: ["query"],
      additionalProperties: false
    },
    async run({ query, limit=20 }, ctx) {
      const q = normalize(query);
      const hits = [];
      for ( const entry of game.journal ) {
        for ( const page of entry.pages ) {
          if ( !canSee(page, ctx.user) ) continue;
          const raw = page.text?.markdown || htmlToText(page.text?.content, 100_000);
          const text = String(raw ?? "");
          const at = normalize(text).indexOf(q);
          if ( (at < 0) && !normalize(page.name).includes(q) ) continue;
          const from = Math.max(0, at - 150);
          hits.push({ journal: entry.name, page: page.name, uuid: page.uuid,
            excerpt: at >= 0 ? text.slice(from, at + q.length + 150) : null });
          if ( hits.length >= limit ) return { hits, more: true };
        }
      }
      return { hits, more: false };
    }
  },

  roll_dice: {
    description: "Rolls dice in Foundry and shows them in the chat (e.g. \"1d20+5\", \"8d6\"). Use it for NPC checks, damage, improvised random tables. By default the roll is visible to the GM only.",
    input_schema: {
      type: "object",
      properties: {
        formula: { type: "string" },
        flavor: { type: "string", description: "Description, e.g. \"Guard's Perception\"." },
        speaker_actor_uuid: { type: "string", description: "Roll on behalf of this actor (its @attributes can be used in the formula)." },
        public: { type: "boolean", description: "Show to everyone. Default false (GM only)." }
      },
      required: ["formula"],
      additionalProperties: false
    },
    async run({ formula, flavor, speaker_actor_uuid, public: isPublic=false }) {
      const actor = speaker_actor_uuid ? await resolveActor(speaker_actor_uuid) : null;
      const roll = await new Roll(formula, actor?.getRollData() ?? {}).evaluate();
      const msg = await roll.toMessage({ flavor, speaker: ChatMessage.implementation.getSpeaker({ actor }) }, visibility(!isPublic));
      if ( msg ) record({ kind: "create", uuid: msg.uuid, label: t("Undo.Roll", { formula }) });
      return { formula: roll.formula, total: roll.total, dice: roll.dice.map(d => ({ faces: d.faces, results: d.results.map(r => r.result) })) };
    }
  },






};

/**
 * Tools enabled for the current settings, in a stable order (keeps the prompt cache warm).
 * With a player user only the read-only player tools are offered.
 */
/** Tools of the Lite version: query the world, roll dice, import from compendiums and edit documents. */
const LITE_TOOLS = new Set(["get_my_characters", "get_world_overview", "search_documents", "list_compendiums", "search_compendiums",
  "import_from_compendium", "get_document", "describe_schema", "update_documents", "create_documents", "send_chat_message",
  "get_chat_log", "search_journal_text", "roll_dice"]);

export function getEnabledTools({ user }={}) {
  return Object.entries(TOOLS).filter(([name, tool]) => {
    if ( !LITE_TOOLS.has(name) ) return false;
    return user ? PLAYER_TOOLS.has(name) : !tool.playerOnly;
  });
}

export function toolDefinitions(ctx={}) {
  return getEnabledTools(ctx).map(([name, tool]) => ({ name, description: tool.description, input_schema: tool.input_schema }));
}

/**
 * Run a tool. ctx.user is set for player requests: the tool set is restricted and each tool filters by that
 * user's permissions.
 */
export async function runTool(name, input, ctx={}) {
  const tool = getEnabledTools(ctx).find(([n]) => n === name)?.[1];
  if ( !tool ) throw new Error(`Unknown or disallowed tool: ${name}`);
  // Foundry and systems report validation problems as notifications that only the GM would see;
  // capture them so Claude gets the exact message and can fix its data.
  const captured = [];
  const notes = ui.notifications;
  const original = { error: notes.error, warn: notes.warn };
  for ( const level of ["error", "warn"] ) {
    notes[level] = function(message, options) {
      captured.push(`${level}: ${String(message?.message ?? message)}`);
      return original[level].call(this, message, options);
    };
  }
  try {
    const result = await tool.run(input ?? {}, ctx);
    if ( !captured.length ) return result;
    Hooks.callAll("claudeGM.toolNotices", name, captured);
    const notices = { foundryNotices: captured, hint: "Foundry showed these notices while the tool ran; check whether something failed to be stored." };
    return (result && (typeof result === "object") && !Array.isArray(result)) ? { ...result, ...notices } : { result, ...notices };
  } catch (err) {
    if ( captured.length ) {
      Hooks.callAll("claudeGM.toolNotices", name, captured);
      err.message = `${err.message} | Foundry notices: ${captured.join(" | ")}`;
    }
    throw err;
  } finally {
    notes.error = original.error;
    notes.warn = original.warn;
  }
}
