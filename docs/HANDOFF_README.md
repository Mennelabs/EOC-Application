# Common Ground — Claude Code hand-off package

1. Create an empty folder for the repository (e.g. `common-ground/`) and unzip this package into it, so `CLAUDE.md`, `docs/` and `mockups/` sit at the top level.
2. Open Claude Code in that folder. It reads `CLAUDE.md` automatically every session.
3. Paste the contents of `KICKOFF_PROMPT.md` as the first message.
4. Review its first deliverables (requirements index, architecture, ADRs, scaffold, layer-1 plan) before letting it build features.

Contents:

- `CLAUDE.md`: standing rules and fixed decisions
- `KICKOFF_PROMPT.md`: first message to paste
- `docs/00`–`06`: original BRD/FRD plus the six requirement tabs (exported 2026-10-12)
- `mockups/`: source markup for the resident and console mockups. These files need the canvas runtime to render, so Claude Code reads them as layout and content direction. To view them, open the live canvases: resident intake https://claude.ai/artifact/DJAoMY3jVcQge1VL4H3jo2 and console https://claude.ai/artifact/QodkEvieaEvPuUrPFAZFe3

If you change the requirements doc later, re-export the changed tab into `docs/` and tell Claude Code which IDs changed.
