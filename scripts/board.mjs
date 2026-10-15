/** Quadro de investigação: recurso da versão completa. */
const full = () => ui.notifications.info("O Quadro de investigação faz parte da versão completa do Claude GM.");

export const BOARD_SYSTEM = "";
export const addClue = () => null;
export const removeClue = () => null;
export const saveAnalysis = () => null;
export const analysisRequest = () => "";
export const boardJournal = async () => null;
export class BoardApp {
  static handlers = {};
  static open() { full(); }
}
