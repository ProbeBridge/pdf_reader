# Bundled translation fallback

`fallback.txt` supplies native UI translations for builds without an apptranslator cache. A nonempty `.work/translations.txt` still takes precedence.

The catalog comes from [SumatraPDF 3.6.1](https://github.com/sumatrapdfreader/sumatrapdf/blob/3.6.1rel/translations/translations.txt), distributed with SumatraPDF under GPLv3. It retains the upstream translations, adds source entries for current commands, and includes Simplified/Traditional Chinese translations for this fork's controls. Untranslated newer labels fall back to English.

Regenerate from `sumatrapdf/` with `bun cmd/update-local-translations.ts`. The updater verifies the pinned upstream checksum and performs no apptranslator submissions. Normal builds use the committed snapshot offline.
