# Claude GM Lite

[English](README.md) | [Português (Brasil)](README.pt-BR.md)

A **free, limited** version of Claude GM, a **Foundry VTT** module (v13–v14, tested with dnd5e) that lets the GM talk to [Claude](https://claude.com) in the Foundry chat to look up and adjust the open world. The interface is available in **English and Brazilian Portuguese**, and Claude replies in the language you write in.

## What it does

- **Chat:** `/claude <request>` (default model), `/claude! <request>` (stronger model) and `/ai <request>` (fast and cheap).
- **Included tools:** search documents and read sheets (with computed AC, modifiers and DCs), browse and import from compendiums, search journals, read the session chat log, roll dice, send chat messages, and create or edit documents.
- **Approval:** every change can ask for your confirmation before it is saved.
- **Undo:** `/claude undo` reverts what Claude created or changed.
- **Panel** with history, buttons on sheets and on the token HUD, a request queue and `/claude stop`.
- **Players (optional):** they can ask questions about their own character sheet, read-only.
- Every command works in English and Portuguese (`undo`/`desfazer`, `stop`/`parar`, `summary`/`resumo`, `queue`/`fila`...). Type `/claude help` for the list.

## What is left out (full version)

This version uses only the **Anthropic API**. It does not include: the Claude Code bridge, letters between players and NPCs, the investigation board, Obsidian integration, factions, scene and token creation, combat, treasure and shops, weather and visual effects, calendar, and scripts. The full version is not public.

## Installation

1. Copy this folder to `Data/modules/claude-gm-lite` in your Foundry (the folder name must be `claude-gm-lite`).
2. Enable **Claude GM Lite** in **Manage Modules** in your world.
3. In **Settings → Claude GM Lite**, paste your Anthropic API key. It is stored only in the GM's browser and never sent to players.

API usage is billed by Anthropic. To spend less, use `/ai` for simple tasks and `/claude reset` when you change topic.

## License

[MIT](LICENSE). The Anthropic SDK bundled in `vendor/` keeps its original license.

## Author

João Vitor Ferreira ([@JoaoVitorFerreiraS2](https://github.com/JoaoVitorFerreiraS2)).

## Tools used

- [Claude Code](https://claude.com/claude-code): development of the module.
- [Foundry VTT](https://foundryvtt.com): platform.
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript): API calls (in `vendor/`).
