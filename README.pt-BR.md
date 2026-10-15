# Claude GM Lite

[English](README.md) | **Português (Brasil)**

Versão **gratuita e limitada** do Claude GM, um módulo para **Foundry VTT** (v13–v14, testado no dnd5e) que deixa o Mestre conversar com o [Claude](https://claude.com) no chat do Foundry para consultar e ajustar o mundo aberto.

## O que ela faz

- **Chat:** `/claude <pedido>` (modelo padrão), `/claude! <pedido>` (modelo mais forte) e `/ia <pedido>` ou `/ai <pedido>` (rápido e barato).
- **Ferramentas incluídas:** buscar documentos e ler fichas (com CA, modificadores e CDs calculados), consultar e importar de compêndios, buscar nos diários, ver o chat da sessão, rolar dados, enviar mensagens e criar ou editar documentos.
- **Aprovação:** cada alteração pode pedir a sua confirmação antes de ser gravada.
- **Desfazer:** `/claude desfazer` (ou `undo`) reverte o que o Claude criou ou alterou.
- **Painel** com histórico, botões nas fichas e no HUD do token, fila de pedidos e `/claude parar`.
- **Jogadores (opcional):** podem tirar dúvidas sobre a própria ficha, em modo somente leitura.
- Todos os comandos funcionam em inglês e em português. A interface existe em **inglês e português do Brasil**, e o Claude responde no idioma em que você escrever. `/claude ajuda` lista tudo.

## O que fica de fora (versão completa)

Esta versão usa apenas a **API da Anthropic** e não inclui: ponte com o Claude Code, cartas entre jogadores e NPCs, quadro de investigação, integração com Obsidian, facções, criação de cenas e tokens, combate, tesouro e lojas, clima e efeitos visuais, calendário e scripts. A versão completa não é pública.

## Instalação

1. Copie esta pasta para `Data/modules/claude-gm-lite` no seu Foundry (o nome da pasta precisa ser `claude-gm-lite`).
2. Ative **Claude GM Lite** em **Gerenciar Módulos** no seu mundo.
3. Em **Configurações → Claude GM Lite**, cole sua chave da API da Anthropic. Ela fica salva só no navegador do Mestre e nunca é enviada aos jogadores.

O uso da API é cobrado pela Anthropic. Para gastar menos, use `/ia` em tarefas simples e `/claude reset` ao trocar de assunto.

## Licença

[MIT](LICENSE). O SDK da Anthropic incluído em `vendor/` mantém a licença original.

## Autor

João Vitor Ferreira ([@JoaoVitorFerreiraS2](https://github.com/JoaoVitorFerreiraS2)).

## Ferramentas utilizadas

- [Claude Code](https://claude.com/claude-code): desenvolvimento do módulo.
- [Foundry VTT](https://foundryvtt.com): plataforma.
- [SDK da Anthropic](https://github.com/anthropics/anthropic-sdk-typescript): chamadas à API (em `vendor/`).
