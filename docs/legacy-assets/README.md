# Legacy assets kept for v2

The legacy app (`backend/`, `frontend/`) was removed on 2026-10-07; it is still available in git history
(last commit containing it: see `git log -- frontend/`). Only these data files were kept:

| File | What it is | Used by |
|---|---|---|
| `india-state-districts.json` | Indian states → districts list | Storefront checkout address form (plan 11 Task 7) |
| `addressData.js` | Country list and Indian states used by the legacy address form | Source for the `IndianStateSchema` enum in `@craftoria/contracts` (plan 02 Task 2) — verify against the 36 states/UTs |
