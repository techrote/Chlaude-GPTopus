---
description: Open the local OAI web configuration panel (workers, efforts, tiers, guardrails, quotas, trace). Usage: /oai:config
---

Launch the OAI configuration panel for the user.

Do exactly this:

1. Run this command with the Bash tool in the background (`run_in_background: true`), from any directory:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/oai-config.mjs"`
2. Read its output until it prints the line starting with `OAI config panel:` and give the user that URL. The script also opens it in the default browser.
3. Tell the user briefly: values are stored as Windows user environment variables (elsewhere: a JSON file, see the script header) and apply on the next worker call (the bridge re-reads the store; ULTRA and worker-list changes still need a restart); the panel shows a "CHANGES SAVED" banner until they press I RESTARTED. The server binds 127.0.0.1 only and exits by itself when the page is closed or after 30 idle minutes.
4. Do not open, read or edit the configuration values yourself, and never print API keys.
