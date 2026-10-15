/** Cartas entre jogadores e NPCs: recurso da versão completa. */
const full = () => ui.notifications.info("Cartas e Correio fazem parte da versão completa do Claude GM.");

export const letterTools = {};
export const letterOf = () => null;
export const composeLetter = async () => full();
export const receiveLetter = async () => null;
export const updateLetter = async () => null;
export const draftPrompt = () => "";
export class MailApp {
  static handlers = {};
  static open() { full(); }
}
