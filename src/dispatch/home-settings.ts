/** These settings also travel in --settings because --restricted ignores the user settings file. */
export const claudeHomeSettings = {
  syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false,
  disableClaudeAiConnectors: true,
  autoMemoryEnabled: false,
  enabledPlugins: {
    "cc-plugin-agents-md@builtin": false,
    "cc-plugin-telemetry@builtin": false,
    "cc-plugin-privacy@builtin": false,
    "cc-plugin-plugin-authoring@builtin": false,
  },
};

export const codexHomeSettings = {
  skills: { include_instructions: false, bundled: { enabled: false } },
  features: {plugins: false, remote_plugin: false, apps: false, hooks: false},
};
