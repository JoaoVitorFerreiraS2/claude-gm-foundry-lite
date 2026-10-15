/** Localization helper: `t("Help.Gm")` → game.i18n for the key "CLAUDEGM.Help.Gm". Source language: lang/en.json. */
export const t = (key, data) => (data
  ? game.i18n.format(`CLAUDEGM.${key}`, data)
  : game.i18n.localize(`CLAUDEGM.${key}`));
