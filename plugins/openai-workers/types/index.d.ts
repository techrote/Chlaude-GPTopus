// Types contract for the oai mod, read by the Claude Code mod validator.
// oai.run is one OpenAI worker's per-agent step state (see hooks/step.js newRun).
declare module 'claude-code' {
  interface PluginState {
    'oai': {
      run: {
        responseId?: string | null;
        pending?: unknown[];
        seenPrompts?: unknown;
        steps: number;
        effort?: string;
        estimatedUsd: number;
        usageStatus?: string;
        finished?: unknown;
        handback?: unknown;
      };
    };
  }
}
