/**
 * Tools that Claude can call to read and change the current world.
 * Each tool has an Anthropic tool definition and a `run(input)` that returns a JSON-serialisable result.
 * Throwing from `run` sends an error tool_result back to Claude.
 */
import { MODULE_ID } from "./constants.mjs";
import { record, snapshotBefore } from "./undo.mjs";
import { integrationTools } from "./integrations.mjs";
import { letterTools } from "./letters.mjs";

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
const PLAYER_TOOLS = new Set(["get_my_characters", "get_document", "search_rules", "search_journal_text",
  "get_level_up_options", "search_class_spells"]);

const docLabel = doc => `${doc.documentName} "${doc.name ?? doc.id}"`;

/**
 * Obsidian link: when Claude sets flags.claude-gm.note (the note's path inside the vault),
 * stamp when it was synced so later "what changed in the notes?" questions can be answered.
 * Works on nested data or on flat dot-path changes.
 */
function stampNoteSync(data) {
  if ( !data ) return data;
  const flat = flattenObject(data);
  const hasNote = Object.keys(flat).some(k => k === `flags.${MODULE_ID}.note`);
  if ( !hasNote ) return data;
  if ( Object.keys(data).some(k => k.includes(".")) ) data[`flags.${MODULE_ID}.syncedAt`] = Date.now();
  else foundry.utils.setProperty(data, `flags.${MODULE_ID}.syncedAt`, Date.now());
  return data;
}

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
    note: `Resultado com ${json.length} caracteres foi cortado. Use o parâmetro "fields" para pedir apenas os campos necessários.`,
    partial: json.slice(0, MAX_RESULT_CHARS)
  };
}

async function resolve(uuid) {
  const doc = await fromUuid(uuid);
  if ( !doc ) throw new Error(`Documento não encontrado: ${uuid}`);
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
    window: { title: `${game.i18n.localize("CLAUDEGM.Confirm.Title")}: ${title}` },
    content: `<div class="claude-gm-confirm">${bodyHTML}</div>`,
    position: { width: 560 },
    rejectClose: false,
    modal: true
  });
  if ( ok !== true ) throw new Error(game.i18n.localize("CLAUDEGM.Confirm.Declined"));
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
  if ( !actor ) throw new Error(`${uuid} não é um ator nem um token com ator.`);
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
      throw new Error(`Atividade com tipo inválido "${act.type}". Tipos válidos: ${Object.keys(types).join(", ")}.`);
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
  return typeof value === "string" ? `string (ex.: "${value.slice(0, 40)}")` : `${typeof value} (ex.: ${JSON.stringify(value)})`;
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
    out[path] = `EmbeddedCollection<${field.element.documentName}> (crie com parent_uuid)`;
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
    description: "Lista os personagens que pertencem ao jogador que está perguntando (nome, uuid, classe, nível). Comece por aqui e depois use get_document no uuid com fields.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    playerOnly: true,
    async run(_input, ctx) {
      if ( !ctx.user ) throw new Error("Só para perguntas de jogadores.");
      const owned = game.actors.filter(a => a.testUserPermission(ctx.user, "OWNER"));
      return owned.map(a => ({
        uuid: a.uuid, name: a.name, type: a.type, assigned: ctx.user.character?.id === a.id,
        level: a.system?.details?.level ?? null,
        classes: Object.values(a.classes ?? {}).map(c => `${c.name} ${c.system?.levels ?? ""}`.trim())
      }));
    }
  },

  get_world_overview: {
    description: "Visão geral do mundo atual: sistema de jogo, versão do Foundry, cena ativa, usuários, combate e contagem de documentos por tipo. Use no início quando precisar se orientar.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const counts = {};
      for ( const t of WORLD_TYPES ) counts[t] = game.collections.get(t)?.size ?? 0;
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
        documentTypes: Object.fromEntries(WORLD_TYPES.map(t => [t, game.documentTypes?.[t] ?? []])),
        counts
      };
    }
  },

  search_documents: {
    description: "Procura documentos do mundo por tipo e, opcionalmente, por parte do nome (ignora acentos e maiúsculas), subtipo do sistema ou pasta. Retorna uuid, nome, tipo e pasta.",
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: WORLD_TYPES },
        query: { type: "string", description: "Trecho do nome a procurar." },
        subtype: { type: "string", description: "Subtipo do sistema, ex.: npc, character, weapon, spell." },
        folder: { type: "string", description: "Trecho do nome da pasta." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Padrão 50." }
      },
      required: ["document_type"],
      additionalProperties: false
    },
    async run({ document_type, query, subtype, folder, limit=50 }, ctx) {
      const collection = game.collections.get(document_type);
      if ( !collection ) throw new Error(`Tipo sem coleção no mundo: ${document_type}`);
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
    description: "Lista os compêndios disponíveis (do sistema, de módulos e do mundo) com id, nome, tipo de documento e quantidade de entradas.",
    input_schema: {
      type: "object",
      properties: { document_type: { type: "string", description: "Filtra por tipo, ex.: Actor, Item, JournalEntry." } },
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
    description: "Procura entradas nos compêndios (ex.: monstros, magias, itens do SRD) por parte do nome (ignora acentos), subtipo ou compêndio. Retorna uuid, nome, tipo e compêndio; use get_document no uuid para ver a ficha completa e import_from_compendium para trazer ao mundo.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Trecho do nome, ex.: veteran, bola de fogo." },
        document_type: { type: "string", description: "Actor, Item, JournalEntry, RollTable, Scene, Macro..." },
        subtype: { type: "string", description: "Subtipo do sistema, ex.: npc, spell, weapon." },
        packs: { type: "array", items: { type: "string" }, description: "Ids de compêndios para restringir a busca." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Padrão 30." }
      },
      additionalProperties: false
    },
    async run({ query, document_type, subtype, packs, limit=30 }, ctx) {
      if ( !query && !subtype ) throw new Error("Informe query ou subtype.");
      const q = normalize(query);
      const results = [];
      let total = 0;
      for ( const pack of game.packs ) {
        if ( document_type && (pack.documentName !== document_type) ) continue;
        if ( packs?.length && !packs.includes(pack.collection) ) continue;
        if ( ctx.user && !pack.testUserPermission(ctx.user, "OBSERVER") ) continue;
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
    description: "Traz documentos de compêndios para o mundo, opcionalmente já modificados. Use para criar coisas baseadas em conteúdo existente (ex.: NPC baseado na ficha do Veterano, com outro nome e biografia) em vez de montar a ficha do zero. Com parent_uuid, o item/efeito é adicionado a um ator. changes usa caminhos com ponto, como em update_documents.",
    input_schema: {
      type: "object",
      properties: {
        imports: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              uuid: { type: "string", description: "UUID da entrada no compêndio (Compendium....)." },
              changes: { type: "object", description: "Alterações aplicadas antes de criar, ex.: {\"name\": \"Capitão Dorn\"}." },
              folder: { type: "string", description: "Nome ou UUID de uma pasta existente para o documento." },
              parent_uuid: { type: "string", description: "Ator (ou outro documento) que vai receber o item." }
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
        if ( !s.pack ) throw new Error(`${imports[i].uuid} não é uma entrada de compêndio; use create_documents.`);
      });
      const preview = imports.map((imp, i) => {
        const target = imp.parent_uuid ? ` → ${escapeHTML(imp.parent_uuid)}` : "";
        const changes = imp.changes ? pre(flattenObject(imp.changes)) : "";
        return changes
          ? section(`${escapeHTML(sources[i].documentName)}: ${escapeHTML(sources[i].name)}${target}`, changes, imports.length === 1)
          : `<p><b>${escapeHTML(sources[i].documentName)}: ${escapeHTML(sources[i].name)}${target}</b></p>`;
      }).join("");
      await approve(`importar ${imports.length} documento(s) de compêndio`, preview);

      const results = [];
      for ( const [i, imp] of imports.entries() ) {
        const source = sources[i];
        let created;
        if ( imp.parent_uuid ) {
          const parent = await resolve(imp.parent_uuid);
          const data = source.toObject();
          delete data._id;
          foundry.utils.setProperty(data, "_stats.compendiumSource", source.uuid);
          if ( imp.changes ) foundry.utils.mergeObject(data, normalizeActivities(stampNoteSync(foundry.utils.expandObject(imp.changes))));
          [created] = await parent.createEmbeddedDocuments(source.documentName, [data]);
        } else {
          const collection = game.collections.get(source.documentName);
          if ( !collection ) throw new Error(`Não dá para importar ${source.documentName} direto no mundo.`);
          const data = collection.fromCompendium(source);
          if ( imp.changes ) {
            const changes = stampNoteSync(foundry.utils.expandObject(imp.changes));
            if ( source.documentName === "Actor" ) syncPrototypeTokenName(changes, source.name);
            foundry.utils.mergeObject(data, changes);
          }
          if ( imp.folder ) {
            const folder = findFolder(imp.folder, source.documentName);
            if ( !folder ) throw new Error(`Pasta "${imp.folder}" de ${source.documentName} não existe; crie-a antes com create_documents.`);
            data.folder = folder.id;
          }
          created = await getDocumentClass(source.documentName).create(data);
        }
        if ( !created ) {
          results.push({ source: source.uuid, error: "Criação cancelada pelo sistema ou por outro módulo." });
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
    description: "Lê os dados de um documento pelo UUID (ex.: Actor.abc, Actor.abc.Item.def, Scene.x.Token.y, Compendium...). Coleções embutidas vêm resumidas (uuid/nome/tipo) a menos que include_embedded seja true. Use fields para ler só alguns caminhos (ex.: system.attributes.hp); nesse modo também vêm os valores calculados pelo sistema (derived), como CA, HP máximo e modificadores.",
    input_schema: {
      type: "object",
      properties: {
        uuid: { type: "string" },
        fields: { type: "array", items: { type: "string" }, description: "Caminhos com ponto a retornar." },
        include_embedded: { type: "boolean" }
      },
      required: ["uuid"],
      additionalProperties: false
    },
    async run({ uuid, fields, include_embedded=false }, ctx) {
      const doc = await resolve(uuid);
      if ( !canSee(doc, ctx.user) ) throw new Error("Este jogador não tem permissão para ver esse documento.");
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
    description: "Lista os campos (caminho -> tipo, opções e valor inicial) de um tipo de documento e, se informado, do subtipo (ex.: Actor/npc, Item/weapon, ou tipos de módulos como Actor/add_Edit_My_Thigs_DnD.faccao). Para tipos de módulos que guardam dados em flags, mostra também a estrutura das flags de uma ficha existente. Use antes de criar documentos ou quando não souber o caminho de um campo.",
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", description: "Ex.: Actor, Item, JournalEntryPage, Token, ActiveEffect, Scene." },
        subtype: { type: "string" }
      },
      required: ["document_type"],
      additionalProperties: false
    },
    async run({ document_type, subtype }) {
      const cls = getDocumentClass(document_type);
      if ( !cls ) throw new Error(`Tipo de documento desconhecido: ${document_type}`);
      const fields = {};
      describeField(cls.schema, "", fields);
      let flagsExample;
      if ( subtype ) {
        const model = CONFIG[document_type]?.dataModels?.[subtype];
        if ( model ) describeField(model.schema, "system", fields);
        else fields.system = "sem DataModel registrado para este subtipo";
        // Types added by modules often keep their data in flags: show the structure of an existing one.
        const example = game.collections.get(document_type)?.find(d => (d.type === subtype) && !foundry.utils.isEmpty(d.flags));
        if ( example ) flagsExample = { from: example.uuid, flags: shapeOf(example.toObject().flags) };
      }
      return {
        document_type, subtype: subtype ?? null, availableSubtypes: game.documentTypes?.[document_type] ?? [], fields,
        ...(flagsExample ? { flagsExample, note: "Os dados deste tipo ficam em flags; altere com caminhos como flags.<módulo>.<campo>." } : {})
      };
    }
  },

  update_documents: {
    description: "Atualiza um ou mais documentos. Cada item tem uuid e changes (objeto com caminhos em ponto, ex.: {\"system.attributes.hp.value\": 10, \"name\": \"Novo nome\"}). Para remover uma chave use \"-=chave\": null. Retorna os valores gravados para você conferir.",
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
          `<table><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr>${rows}</table>`, updates.length === 1);
      }).join("");
      await approve(`atualizar ${docs.length} documento(s)`, preview);

      const results = [];
      for ( const [i, u] of updates.entries() ) {
        const doc = docs[i];
        stampNoteSync(u.changes);
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
    description: "Cria documentos. Para documentos do mundo informe document_type (Actor, Item, JournalEntry, Scene, Macro, RollTable, Folder...) e data. Para documentos embutidos (Item em um Actor, JournalEntryPage em um JournalEntry, Token/Tile/AmbientLight/Note em uma Scene, ActiveEffect) informe também parent_uuid.",
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
      for ( const d of documents ) d.data = normalizeActivities(stampNoteSync(expand(d.data)));
      const preview = documents.map(d => section(
        `${escapeHTML(d.document_type)}${d.parent_uuid ? ` em ${escapeHTML(d.parent_uuid)}` : ""}: ${escapeHTML(d.data?.name ?? "")}`,
        pre(d.data), documents.length === 1
      )).join("");
      await approve(`criar ${documents.length} documento(s)`, preview);

      const results = [];
      for ( const d of documents ) {
        let created;
        if ( d.parent_uuid ) {
          const parent = await resolve(d.parent_uuid);
          [created] = await parent.createEmbeddedDocuments(d.document_type, [d.data]);
        } else {
          const cls = getDocumentClass(d.document_type);
          if ( !cls ) throw new Error(`Tipo de documento desconhecido: ${d.document_type}`);
          created = await cls.create(d.data);
        }
        if ( created ) record({ kind: "create", uuid: created.uuid, label: docLabel(created) });
        results.push(created ? summarize(created) : { error: "Criação cancelada pelo sistema ou por outro módulo." });
      }
      return { results };
    }
  },


  send_chat_message: {
    description: "Publica uma mensagem no chat do Foundry (narração, descrição, aviso). Por padrão vai para todos; use gm_only para sussurrar só ao Mestre. O conteúdo é HTML.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string" },
        speaker_alias: { type: "string", description: "Nome exibido como autor, ex.: Narrador." },
        speaker_actor_uuid: { type: "string", description: "Falar como este ator." },
        gm_only: { type: "boolean" },
        language: { type: "string", description: "Idioma do Polyglot (id de list_languages). Exige speaker_actor_uuid; só quem conhece o idioma entende." }
      },
      required: ["content"],
      additionalProperties: false
    },
    async run({ content, speaker_alias, speaker_actor_uuid, gm_only=false, language }) {
      const actor = speaker_actor_uuid ? await resolveActor(speaker_actor_uuid) : null;
      if ( language ) {
        if ( !game.modules.get("polyglot")?.active ) throw new Error("O Polyglot não está ativo.");
        if ( !actor ) throw new Error("Para falar em um idioma, informe speaker_actor_uuid.");
      }
      if ( !gm_only ) await approve("enviar mensagem pública", foundry.utils.cleanHTML(content));
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
      if ( msg ) record({ kind: "create", uuid: msg.uuid, label: "mensagem no chat" });
      return { uuid: msg?.uuid ?? null };
    }
  },


  get_chat_log: {
    description: "Lê as mensagens do chat do mundo (inclusive rolagens e sussurros) das últimas horas, em ordem cronológica, para resumir a sessão ou entender o que aconteceu.",
    input_schema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Janela de tempo para trás. Padrão 6." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Máximo de mensagens (as mais recentes). Padrão 400." }
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
    description: "Procura um texto dentro das páginas de todos os diários do mundo (não só no nome). Retorna diário, página e um trecho em volta de cada ocorrência.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Padrão 20." }
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
    description: "Rola dados no Foundry e mostra no chat (ex.: \"1d20+5\", \"8d6\"). Use para testes de NPCs, danos, tabelas aleatórias improvisadas. Por padrão a rolagem fica só para o Mestre.",
    input_schema: {
      type: "object",
      properties: {
        formula: { type: "string" },
        flavor: { type: "string", description: "Descrição, ex.: \"Percepção do guarda\"." },
        speaker_actor_uuid: { type: "string", description: "Rolar em nome deste ator (pode usar @atributos dele na fórmula)." },
        public: { type: "boolean", description: "Mostrar para todos. Padrão false (só o Mestre)." }
      },
      required: ["formula"],
      additionalProperties: false
    },
    async run({ formula, flavor, speaker_actor_uuid, public: isPublic=false }) {
      const actor = speaker_actor_uuid ? await resolveActor(speaker_actor_uuid) : null;
      const roll = await new Roll(formula, actor?.getRollData() ?? {}).evaluate();
      const msg = await roll.toMessage({ flavor, speaker: ChatMessage.implementation.getSpeaker({ actor }) }, visibility(!isPublic));
      if ( msg ) record({ kind: "create", uuid: msg.uuid, label: `rolagem ${formula}` });
      return { formula: roll.formula, total: roll.total, dice: roll.dice.map(d => ({ faces: d.faces, results: d.results.map(r => r.result) })) };
    }
  },






};

Object.assign(TOOLS, integrationTools({ resolve, resolveActor, approve, normalize, htmlToText }), letterTools);

/**
 * Tools enabled for the current settings, in a stable order (keeps the prompt cache warm).
 * With a player user only the read-only player tools are offered.
 */
/** Ferramentas da versão limitada: consultar o mundo, rolar dados, importar de compêndios e editar documentos. */
const LITE_TOOLS = new Set(["get_my_characters", "get_world_overview", "search_documents", "list_compendiums", "search_compendiums",
  "import_from_compendium", "get_document", "describe_schema", "update_documents", "create_documents", "send_chat_message",
  "get_chat_log", "search_journal_text", "search_rules", "roll_dice"]);

export function getEnabledTools({ user }={}) {
  return Object.entries(TOOLS).filter(([name, t]) => {
    if ( !LITE_TOOLS.has(name) ) return false;
    if ( t.requiresSetting && !game.settings.get(MODULE_ID, t.requiresSetting) ) return false;
    return user ? PLAYER_TOOLS.has(name) : !t.playerOnly;
  });
}

/** Definitions of the tools a player request may use (the bridge serves these on its player endpoint). */
export function playerToolDefinitions() {
  return Object.entries(TOOLS).filter(([name]) => PLAYER_TOOLS.has(name))
    .map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
}

export function toolDefinitions(ctx={}) {
  return getEnabledTools(ctx).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
}

/**
 * Run a tool. ctx.user is set for player requests: the tool set is restricted and each tool filters by that
 * user's permissions.
 */
export async function runTool(name, input, ctx={}) {
  const tool = getEnabledTools(ctx).find(([n]) => n === name)?.[1];
  if ( !tool ) throw new Error(`Ferramenta desconhecida ou não permitida: ${name}`);
  // Foundry and systems report validation problems as notifications that only the GM would see;
  // capture them so Claude gets the exact message and can fix its data.
  const captured = [];
  const notes = ui.notifications;
  const original = { error: notes.error, warn: notes.warn };
  for ( const level of ["error", "warn"] ) {
    notes[level] = function(message, options) {
      captured.push(`${level === "error" ? "erro" : "aviso"}: ${String(message?.message ?? message)}`);
      return original[level].call(this, message, options);
    };
  }
  try {
    const result = await tool.run(input ?? {}, ctx);
    if ( !captured.length ) return result;
    Hooks.callAll("claudeGM.toolNotices", name, captured);
    const notices = { foundryNotices: captured, hint: "O Foundry mostrou estes avisos durante a ferramenta; confira se algo deixou de ser gravado." };
    return (result && (typeof result === "object") && !Array.isArray(result)) ? { ...result, ...notices } : { result, ...notices };
  } catch (err) {
    if ( captured.length ) {
      Hooks.callAll("claudeGM.toolNotices", name, captured);
      err.message = `${err.message} | Avisos do Foundry: ${captured.join(" | ")}`;
    }
    throw err;
  } finally {
    notes.error = original.error;
    notes.warn = original.warn;
  }
}
