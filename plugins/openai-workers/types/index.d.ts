// Types contract for the openai-workers mod, read by the Claude Code mod validator.
// openai-workers.run is one OpenAI worker's per-agent step state (see hooks/step.js newRun).
declare module 'claude-code' {
  interface PluginState {
    'openai-workers': {
      run: {
        responseId?: string | null;
        pending?: unknown[];
        seenPrompts?: unknown;
        steps: number;
        estimatedUsd: number;
        usageStatus?: string;
        finished?: unknown;
        handback?: unknown;
      };
    };
  }
}
