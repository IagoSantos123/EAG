# TASKS — divisão entre agentes

| Agente | Worktree | Branch | API | Postgres |
|---|---|---|---|---|
| Claude Code | `../EAG-claude` | `agente/claude` | 3011 | 5452 |
| Antigravity | `../EAG-agy` | `agente/antigravity` | 3021 | 5462 |

Regra de ouro: **Claude = `server/`**, **Antigravity = `client/`**. Revisão cruzada no fim.

Status: `[ ]` a fazer · `[~]` em andamento · `[x]` mergeado na main

## Rodada 1 (teste do fluxo)

- [ ] **T1 — Testes das regras financeiras** · dono: `claude` · caminhos: `server/test/**`, `server/package.json`
  O README cita testes mas a pasta não existe. Criar `server/test/` com `node --test` usando `embedded-postgres` (banco temporário em porta livre).
  Cobrir: recebimento com caixa fechado é recusado; soma das formas ≠ valor em aberto é recusada; reenvio não duplica pagamento; finalizar pedido não marca como pago; fiado aparece como a receber.
  Pronto quando: `npm test` passa do zero numa máquina sem banco rodando.

- [ ] **T2 — Quebrar `FinancePage.jsx` (527 linhas) em componentes** · dono: `antigravity` · caminhos: `client/src/admin/FinancePage.jsx`, `client/src/admin/finance/**`
  Extrair indicadores, conferência de PIX, caixa e histórico para arquivos em `client/src/admin/finance/`. **Sem mudar comportamento nem visual.**
  Pronto quando: `npm run build` ok e as telas do Financeiro funcionam igual no `rodar-agente.bat`.

- [ ] **T3 — Revisão cruzada** · `claude` revisa o diff de T2 · `antigravity` revisa o diff de T1
  Prompt: "Revise o diff `git diff main...agente/<outro>` seguindo o AGENTS.md. Aponte bugs, quebra de regra e mudança de comportamento. Não edite nada."

## Rodada 2 (preencher depois)
- [ ] T4 — ... · dono: ... · caminhos: ...
