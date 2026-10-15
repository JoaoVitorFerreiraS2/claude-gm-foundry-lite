/**
 * Help and status pages shown by /claude ajuda and /claude status (GM) and /claude ajuda (players).
 * Built from the live state so it only lists what is actually available in this world.
 */
import { MODULE_ID } from "./constants.mjs";

const active = id => game.modules.get(id)?.active ?? false;
const yes = (cond, on, off) => (cond ? `✅ ${on}` : `⬜ ${off}`);

/** Integrations that depend on other modules, and whether each is usable here. */
function integrations() {
  const calendar = active("foundryvtt-simple-calendar-reborn") || active("foundryvtt-simple-calendar");
  return [
    [active("item-piles"), "Lojas e pilhas de tesouro (Item Piles)"],
    [active("sequencer"), "Efeitos visuais JB2A (Sequencer)"],
    [active("fxmaster"), "Clima e partículas (FXMaster)"],
    [calendar, "Calendário, eventos e avanço de tempo (Simple Calendar)"],
    [active("polyglot"), "Mensagens em idiomas (Polyglot)"],
    [active("forien-quest-log"), "Missões (Forien's Quest Log)"],
    [game.system.id === "dnd5e", "Grupo, dificuldade de encontros e moedas (dnd5e)"]
  ].map(([on, label]) => `<li>${on ? "✅" : "⬜"} ${label}${on ? "" : " — módulo inativo"}</li>`).join("");
}

export function gmHelp() {
  return `
<h3>Claude GM — ajuda</h3>

<h4>Comandos</h4>
<ul>
  <li><b>/claude &lt;pedido&gt;</b> — pede algo ao Claude sobre o mundo aberto.</li>
  <li><b>/claude! &lt;pedido&gt;</b> — modelo mais forte, com mais esforço (preparar sessão, tarefas grandes).</li>
  <li><b>/ia &lt;pergunta&gt;</b> — modelo rápido e barato, para perguntas simples.</li>
  <li><b>/claude desfazer</b> — reverte tudo o que o último pedido mudou (mostra a lista antes).</li>
  <li><b>/claude desfazer limpar</b> — apaga o histórico do desfazer (não muda nada no mundo).</li>
  <li><b>/claude parar</b> — interrompe o pedido em andamento.</li>
  <li><b>/claude reset</b> — o Claude esquece a conversa e começa do zero.</li>
  <li><b>/claude painel</b> — abre a janela do Claude.</li>
  <li><b>/claude status</b> — mostra a configuração e a conexão.</li>
  <li><b>/claude resumo</b> — resumo instantâneo dos tokens selecionados (ou da ficha em foco no painel): PV, CA, espaços de magia, usos, condições.</li>
  <li><b>/claude fila</b> — mostra quem está esperando; <b>/claude fila limpar</b> tira as perguntas dos jogadores da fila.</li>
</ul>

<h4>Onde clicar</h4>
<ul>
  <li><b>Robô nos controles de token</b> (barra da esquerda): abre o painel. No painel, comece com <b>!</b> (forte) ou <b>?</b> (rápido).</li>
  <li><b>Robô no cabeçalho</b> de fichas, itens, diários e cenas: abre o painel com aquele documento em foco e ações rápidas.</li>
  <li><b>Robô no HUD do token</b> (clique direito no token): descrever, dar falas, ajustar ao grupo.</li>
</ul>

<h4>O que o Claude faz</h4>
<ul>
  <li><b>Consultar:</b> fichas (com CA, modificadores e CDs calculados), compêndios, diários, regras com fonte, chat da sessão, arquivos de mapas e tokens.</li>
  <li><b>Criar e alterar:</b> atores, itens, diários, cenas a partir de mapas, tokens, combate, condições, rolagens, tabelas, música, mensagens.</li>
  <li><b>Receitas prontas:</b> encontro completo para o grupo, tesouro, loja, cena viva, efeito visual, lembretes da sessão, diário para os jogadores, nomes no estilo da campanha.</li>
</ul>

<h4>Integrações neste mundo</h4>
<ul>${integrations()}</ul>

<h4>Segurança</h4>
<ul>
  <li>Alterações pedem sua aprovação (configurável). Exclusões, scripts e notas do Obsidian <b>sempre</b> pedem.</li>
  <li>Tudo o que o Claude cria, altera ou exclui pode ser desfeito com <b>/claude desfazer</b> (os 30 últimos pedidos, mesmo depois de recarregar). Scripts e efeitos visuais não.</li>
  <li>Os jogadores não veem suas conversas com o Claude.</li>
</ul>

<h4>Jogadores</h4>
<p>Com "Jogadores podem perguntar" ligado, os jogadores usam <b>/claude</b> só para dúvidas <b>sobre o próprio personagem</b>: ficha, regras que se aplicam e a história dele como está registrada. O Claude só lê os personagens de que o jogador é dono, os diários compartilhados com ele e a pasta do Obsidian liberada aos jogadores; recusa história da campanha, monstros, NPCs e segredos, não inventa, não altera nada e aceita 1 pergunta a cada 15 s (20 por hora). Eles também têm <b>/claude resumo</b> (instantâneo, sem IA) e <b>/claude nivel</b> (opções e recomendações para subir de nível, só sugestões). As perguntas entram numa fila e são respondidas uma de cada vez; seus pedidos passam na frente. Você vê todas as perguntas e respostas.</p>

<h4>Exemplos</h4>
<ul>
  <li>/claude monte um encontro médio de mortos-vivos para o grupo</li>
  <li>/claude crie uma ferraria em Vallaki com preços 50% mais caros</li>
  <li>/claude dê vida a esta cena: chuva, luzes e música</li>
  <li>/claude traga o NPC Fulano das notas usando o Veterano como base</li>
  <li>/claude! prepare a próxima sessão a partir das notas</li>
  <li>/ia qual a CA do goblin?</li>
</ul>`;
}

/**
 * @param {object} state
 * @param {boolean} state.bridgeConnected
 * @param {number} state.undoCount
 */
export function gmStatus({ bridgeConnected, undoCount }) {
  const get = key => game.settings.get(MODULE_ID, key);
  const bridge = get("backend") === "bridge";
  const notes = get("notesPath")?.trim();
  return `
<h3>Claude GM — status</h3>
<ul>
  <li><b>Modo:</b> ${bridge ? `Claude Code (seu login) — modelo ${get("cliModel") || "padrão do Claude Code"}` : `API da Anthropic — ${get("model")}, esforço ${get("effort")}`}</li>
  <li>${yes(bridgeConnected, "Ponte conectada", `Ponte desconectada${bridge ? " — rode bridge/iniciar-ponte.cmd" : " (necessária só para o Claude Code e o terminal)"}`)}</li>
  ${bridge ? "" : `<li>${yes(Boolean(get("apiKey")?.trim()), "Chave da API configurada", "Sem chave da API")}</li>`}
  <li>${yes(Boolean(notes), `Pasta de notas: <code>${foundry.utils.escapeHTML(notes ?? "")}</code>`, "Sem pasta de notas do Obsidian")}</li>
  <li>${yes(get("confirmChanges"), "Pede aprovação para alterações", "Alterações sem aprovação (exclusões, scripts e notas ainda pedem)")}</li>
  <li>${yes(get("allowPlayers"), "Jogadores podem perguntar sobre a própria ficha", "Jogadores não podem usar o Claude")}</li>
  <li>${yes(get("allowScript"), "Execução de scripts permitida", "Execução de scripts desligada")}</li>
  <li><b>Desfazer:</b> ${undoCount} pedido(s) guardado(s)</li>
</ul>`;
}

export function playerHelp() {
  const allowed = game.settings.get(MODULE_ID, "allowPlayers");
  if ( !allowed ) return "<h3>Claude</h3><p>O Mestre não liberou o Claude para os jogadores nesta mesa.</p>";
  return `
<h3>Claude — ajuda para jogadores</h3>
<p>Use <b>/claude &lt;pergunta&gt;</b> para tirar dúvidas <b>sobre o seu personagem</b>.</p>
<h4>Atalhos</h4>
<ul>
  <li><b>/claude resumo</b> — PV, CA, espaços de magia, usos que sobram, condições e moedas, na hora (não gasta nada).</li>
  <li><b>/claude nivel</b> — o que o próximo nível dá e o que escolher, com recomendações para o seu personagem.</li>
</ul>
<h4>Pode perguntar</h4>
<ul>
  <li>Números da ficha: atributos, perícias, salvaguardas, CA, HP, deslocamento, proficiências.</li>
  <li>Suas magias, itens, habilidades e talentos: o que fazem, como usar, custos, recargas, CDs.</li>
  <li>Regras que se aplicam a algo da sua ficha (ex.: "como funciona meu Ataque Furtivo?"), e táticas com o que você tem.</li>
  <li>A história do seu personagem, como está registrada na ficha, nos diários que o Mestre compartilhou com você e nas notas liberadas (ex.: "quem é o pai do meu personagem?"). Se não estiver registrado, o Claude não inventa.</li>
</ul>
<h4>Não pode</h4>
<ul>
  <li>História da campanha além do que você já recebeu, NPCs, monstros, mapas, segredos, chances de vencer alguém ou o que vai acontecer — isso é com o Mestre.</li>
  <li>Mudar a ficha: o Claude só lê.</li>
</ul>
<p>A resposta chega no chat só para você e o Mestre. O Mestre vê todas as perguntas. Se outros jogadores perguntarem junto, a sua entra numa fila e você vê a posição. Uma pergunta por vez; limite de 1 a cada 15 s e 20 por hora.</p>
<p><b>/claude reset</b> começa uma conversa nova.</p>`;
}
