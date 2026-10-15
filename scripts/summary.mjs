/**
 * Character summary built straight from the sheet (no AI): instant, exact, free.
 * Players see their own characters; the GM sees the selected tokens or the panel's focused actor.
 */
import { t } from "./i18n.mjs";

const { escapeHTML } = foundry.utils;

const SLOT_LABEL = key => (key === "pact" ? t("Summary.Pact") : t("Summary.SlotLevel", { level: key.replace("spell", "") }));

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
  if ( hp ) row(t("Summary.Hp"), `${hp.value ?? 0}/${hp.max ?? "?"}${hp.temp ? ` ${t("Summary.TempHp", { temp: hp.temp })}` : ""}`);
  row(t("Summary.Ac"), a.ac?.value);
  row(t("Summary.Initiative"), a.init?.total !== undefined ? (a.init.total >= 0 ? `+${a.init.total}` : a.init.total) : undefined);
  row(t("Summary.Speed"), a.movement?.walk ? `${a.movement.walk} ${a.movement.units ?? ""}`.trim() : undefined);
  if ( a.hd?.max ) row(t("Summary.HitDice"), `${a.hd.value}/${a.hd.max}`);
  if ( (hp?.value === 0) && a.death ) row(t("Summary.DeathSaves"), t("Summary.DeathSaveCounts", { success: a.death.success ?? 0, failure: a.death.failure ?? 0 }));
  if ( a.exhaustion ) row(t("Summary.Exhaustion"), a.exhaustion);

  const conditions = [...(actor.statuses ?? [])].map(id => {
    const effect = CONFIG.statusEffects.find(e => e.id === id);
    return escapeHTML(game.i18n.localize(effect?.name ?? effect?.label ?? id));
  });
  row(t("Summary.Conditions"), conditions.length ? conditions.join(", ") : t("Summary.None"));

  const slots = Object.entries(s.spells ?? {})
    .filter(([, v]) => (v?.max ?? 0) > 0)
    .map(([k, v]) => `${SLOT_LABEL(k)}${k === "pact" && v.level ? ` ${t("Summary.PactLevel", { level: v.level })}` : ""}: ${v.value}/${v.max}`);
  if ( slots.length ) row(t("Summary.SpellSlots"), slots.join(" · "));

  const uses = actor.items
    .filter(i => (i.system?.uses?.max ?? 0) > 0)
    .map(i => `<li>${escapeHTML(i.name)}: ${i.system.uses.value}/${i.system.uses.max}${periodsLabel(i.system.uses)}</li>`);

  const coins = Object.entries(s.currency ?? {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
  row(t("Summary.Coins"), coins.join(", ") || t("Summary.None"));

  const level = s.details?.level ? ` — ${t("Summary.Level", { level: s.details.level })}` : "";
  const classes = Object.values(actor.classes ?? {}).map(c => `${escapeHTML(c.name)} ${c.system?.levels ?? ""}`.trim()).join(" / ");
  return `
<h3>${escapeHTML(actor.name)}${level}</h3>
${classes ? `<p>${classes}</p>` : ""}
<ul>${rows.join("")}</ul>
${uses.length ? `<p><b>${t("Summary.LimitedUses")}</b></p><ul>${uses.join("")}</ul>` : ""}`;
}

/** Summaries for the current user: their own characters (players) or selected/focused actors (GM). */
export function summariesFor(user, { focused=null }={}) {
  let actors;
  if ( user.isGM ) {
    const selected = (globalThis.canvas?.ready ? canvas.tokens.controlled : []).map(tk => tk.actor).filter(Boolean);
    actors = selected.length ? selected : (focused ? [focused] : []);
    if ( !actors.length ) return `<p>${t("Summary.SelectTokens")}</p>`;
  }
  else {
    const assigned = user.character;
    actors = game.actors.filter(a => (a.type === "character") && a.testUserPermission(user, "OWNER"));
    if ( assigned ) actors.sort((x, y) => (y.id === assigned.id) - (x.id === assigned.id));
    if ( !actors.length ) return `<p>${t("Summary.NoCharacter")}</p>`;
  }
  return actors.map(characterSummary).join("<hr>");
}
