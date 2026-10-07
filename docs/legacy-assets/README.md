# Legacy assets kept for v2

The legacy app (`backend/`, `frontend/`) was removed on 2026-10-07; it is still available in git history
(last commit containing it: see `git log -- frontend/`). Only these data files were kept:

| File | What it is | Used by |
|---|---|---|
| `india-state-districts.json` | Districts for **only 3 states** (Rajasthan, Maharashtra, Uttar Pradesh), so it's incomplete | Not used as a source of truth. If the checkout needs districts, use a complete dataset |
| `addressData.js` | Country list and Indian states used by the legacy address form | Superseded by `INDIAN_STATES` in `@craftoria/contracts` (all 28 states + 8 union territories) |
