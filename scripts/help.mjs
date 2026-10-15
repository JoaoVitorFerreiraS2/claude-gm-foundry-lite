/**
 * Help and status pages shown by /claude help and /claude status (GM) and /claude help (players).
 * The texts live in lang/*.json; the status page is built from the live settings.
 */
import { MODULE_ID } from "./constants.mjs";
import { t } from "./i18n.mjs";

const yes = (cond, on, off) => (cond ? `✅ ${on}` : `⬜ ${off}`);

export function gmHelp() {
  return t("Help.Gm");
}

/**
 * @param {object} state
 * @param {number} state.undoCount
 */
export function gmStatus({ undoCount }) {
  const get = key => game.settings.get(MODULE_ID, key);
  return `
<h3>${t("Status.Title")}</h3>
<ul>
  <li>${t("Status.Mode", { model: get("model"), effort: get("effort") })}</li>
  <li>${yes(Boolean(get("apiKey")?.trim()), t("Status.KeyOn"), t("Status.KeyOff"))}</li>
  <li>${yes(get("confirmChanges"), t("Status.ConfirmOn"), t("Status.ConfirmOff"))}</li>
  <li>${yes(get("allowPlayers"), t("Status.PlayersOn"), t("Status.PlayersOff"))}</li>
  <li>${t("Status.Undo", { count: undoCount })}</li>
</ul>`;
}

export function playerHelp() {
  return game.settings.get(MODULE_ID, "allowPlayers") ? t("Help.Player") : t("Help.PlayerOff");
}
