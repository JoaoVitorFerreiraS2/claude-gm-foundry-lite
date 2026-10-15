/** Ponte com o Claude Code (CLI local): recurso da versão completa. A versão limitada usa só a API. */
export const isBridgeConnected = () => false;
export const isBridgeBusy = () => false;
export const connectBridge = () => {};
export const sendHello = () => {};
export const remoteLog = () => {};
export const askViaBridge = async () => { throw new Error("A ponte com o Claude Code faz parte da versão completa."); };
export const cancelBridgeRequest = () => {};
export const resetBridgeConversation = () => {};
export const bridgeToolDefinitions = () => [];
export const isBridgeTool = () => false;
export const runBridgeTool = async () => { throw new Error("Ferramenta indisponível."); };
