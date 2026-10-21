## What does this PR do?


## How to test
1. 
2. 

## Checklist
- [ ] `npm run typecheck`, `npm run build` and `cargo test` (in `src-tauri/`) pass
- [ ] Ran the app and saw the change working — tested on: <!-- macOS / Windows / Linux -->
- [ ] New Tauri commands are allowed in `src-tauri/capabilities/default.json`
- [ ] Rust models and `src/types/api.ts` still match 1:1
- [ ] New `api.*` calls have a browser-mode fallback in `src/lib/tauri.ts`
- [ ] No new outbound network request — or it's named here and the user can switch it off
- [ ] Updated `CLAUDE.md` / `docs/ARCHITECTURE.md` if the change alters something they describe
