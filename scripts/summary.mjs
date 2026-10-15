/**
 * Character summary built straight from the sheet (no AI): instant, exact, free.
 * Players see their own characters; the GM sees the selected tokens or the panel's focused actor.
 */
const { escapeHTML } = foundry.utils;

const SLOT_LABEL = key => (key === "pact" ? "Pacto" : `${key.replace("spell", "")}º`);

function periodsLabel(uses) {
  const recovery = uses?.recovery ?? [];
  const labels = recovery.map(r => CONFIG.DND5E?.limitedUsePeriods?.[r.period]?.label ?? r.period).filter(Boolean);
  return labels.length ? ` <span class="claude-gm-note">(${labels.map(l => escapeHTML(game.i18n.localize(l))).join(", ")})</span>` : "";
}

/** One actor's summary as HTML. */
export function characterSummary(actor) {
  const s = actor.system ?? {};
  const a = s.attributes ?? {};
  const rows = [];
  const row = (label, value) => { if ( (value !== undefined) && (value !== null) && (value !== "") ) rows.push(`<li><b>${label}:</b> ${value}</li>`); };

  const hp = a.hp;
  if ( hp ) row("PV", `${hp.value ?? 0}/${hp.max ?? "?"}${hp.temp ? ` (+${hp.temp} temporários)` : ""}`);
  row("CA", a.ac?.value);
  row("Iniciativa", a.init?.total !== undefined ? (a.init.total >= 0 ? `+${a.init.total}` : a.init.total) : undefined);
  row("Deslocamento", a.movement?.walk ? `${a.movement.walk} ${a.movement.units ?? ""}`.trim() : undefined);
  if ( a.hd?.max ) row("Dados de vida", `${a.hd.value}/${a.hd.max}`);
  if ( (hp?.value === 0) && a.death ) row("Testes contra a morte", `✅ ${a.death.success ?? 0} · ❌ ${a.death.failure ?? 0}`);
  if ( a.exhaustion ) row("Exaustão", a.exhaustion);

  const conditions = [...(actor.statuses ?? [])].map(id => {
    const effect = CONFIG.statusEffects.find(e => e.id === id);
    return escapeHTML(game.i18n.localize(effect?.name ?? effect?.label ?? id));
  });
  row("Condições", conditions.length ? conditions.join(", ") : "nenhuma");

  const slots = Object.entries(s.spells ?? {})
    .filter(([, v]) => (v?.max ?? 0) > 0)
    .map(([k, v]) => `${SLOT_LABEL(k)}${k === "pact" && v.level ? ` (nv ${v.level})` : ""}: ${v.value}/${v.max}`);
  if ( slots.length ) row("Espaços de magia", slots.join(" · "));

  const uses = actor.items
    .filter(i => (i.system?.uses?.max ?? 0) > 0)
    .map(i => `<li>${escapeHTML(i.name)}: ${i.system.uses.value}/${i.system.uses.max}${periodsLabel(i.system.uses)}</li>`);

  const coins = Object.entries(s.currency ?? {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
  row("Moedas", coins.join(", ") || "nenhuma");

  const level = s.details?.level ? ` — nível ${s.details.level}` : "";
  const classes = Object.values(actor.classes ?? {}).map(c => `${escapeHTML(c.name)} ${c.system?.levels ?? ""}`.trim()).join(" / ");
  return `
<h3>${escapeHTML(actor.name)}${level}</h3>
${classes ? `<p>${classes}</p>` : ""}
<ul>${rows.join("")}</ul>
${uses.length ? `<p><b>Usos limitados</b></p><ul>${uses.join("")}</ul>` : ""}`;
}

/** Summaries for the current user: their own characters (players) or selected/focused actors (GM). */
export function summariesFor(user, { focused=null }={}) {
  let actors;
  if ( user.isGM ) {
    const selected = (globalThis.canvas?.ready ? canvas.tokens.controlled : []).map(t => t.actor).filter(Boolean);
    actors = selected.length ? selected : (focused ? [focused] : []);
    if ( !actors.length ) return "<p>Selecione tokens no mapa (ou abra o painel com uma ficha em foco) e use <b>/claude resumo</b> de novo.</p>";
  }
  else {
    const assigned = user.character;
    actors = game.actors.filter(a => (a.type === "character") && a.testUserPermission(user, "OWNER"));
    if ( assigned ) actors.sort((x, y) => (y.id === assigned.id) - (x.id === assigned.id));
    if ( !actors.length ) return "<p>Você não tem nenhum personagem.</p>";
  }
  return actors.map(characterSummary).join("<hr>");
}
