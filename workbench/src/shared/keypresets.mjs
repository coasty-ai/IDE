// TEMPORARY: a stand-in written by U4 (the page) so the connect panel and its tests run in this branch. U1 owns the real
// src/shared/keypresets.mjs; when the branches are merged, take U1's file and drop this one. It follows the spec's
// interface only: KEY_PRESETS, presetById(id) and signInVariables. Pure: no node: imports, the page loads it.
//
// KEY_PRESETS: { id, label, fields: [{ name, label, secret, optional, also? }], agents ('all' or agent ids), note, link }.

export const KEY_PRESETS = [
  { id: 'anthropic', label: 'Anthropic', agents: ['claude'], link: 'https://console.anthropic.com/settings/keys',
    note: 'Claude Code will use this key instead of your Claude subscription, and each request is billed to the key.',
    fields: [{ name: 'ANTHROPIC_API_KEY', label: 'API key', secret: true, optional: false }] },
  { id: 'openai', label: 'OpenAI', agents: ['codex'], link: 'https://platform.openai.com/api-keys', note: null,
    fields: [{ name: 'OPENAI_API_KEY', label: 'API key', secret: true, optional: false, also: ['CODEX_API_KEY'] }] },
  { id: 'gemini', label: 'Gemini', agents: 'all', link: 'https://aistudio.google.com/apikey', note: null,
    fields: [{ name: 'GEMINI_API_KEY', label: 'API key', secret: true, optional: false }] },
  { id: 'aws', label: 'AWS', agents: 'all', link: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    note: 'Give agents a key that can do only what their work needs, never your root or admin keys.',
    fields: [
      { name: 'AWS_ACCESS_KEY_ID', label: 'Access key ID', secret: true, optional: false },
      { name: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true, optional: false },
      { name: 'AWS_SESSION_TOKEN', label: 'Session token', secret: true, optional: true },
      { name: 'AWS_REGION', label: 'Region', secret: false, optional: true },
    ] },
  { id: 'google-cloud', label: 'Google Cloud', agents: 'all', link: 'https://console.cloud.google.com/apis/credentials', note: null,
    fields: [
      { name: 'GOOGLE_CLOUD_PROJECT', label: 'Project', secret: false, optional: false },
      { name: 'GOOGLE_API_KEY', label: 'API key', secret: true, optional: true },
    ] },
  { id: 'azure', label: 'Azure', agents: 'all', link: 'https://portal.azure.com/', note: null,
    fields: [
      { name: 'AZURE_CLIENT_ID', label: 'Client ID', secret: false, optional: false },
      { name: 'AZURE_CLIENT_SECRET', label: 'Client secret', secret: true, optional: false },
      { name: 'AZURE_TENANT_ID', label: 'Tenant ID', secret: false, optional: false },
      { name: 'AZURE_SUBSCRIPTION_ID', label: 'Subscription ID', secret: false, optional: true },
    ] },
  { id: 'github', label: 'GitHub', agents: 'all', link: 'https://github.com/settings/tokens/new?description=Workbench&scopes=repo',
    note: 'Copilot CLI may sign in with it.',
    fields: [{ name: 'GH_TOKEN', label: 'Token', secret: true, optional: false, also: ['GITHUB_TOKEN'] }] },
  { id: 'stripe', label: 'Stripe', agents: 'all', link: 'https://dashboard.stripe.com/apikeys', note: null,
    fields: [{ name: 'STRIPE_SECRET_KEY', label: 'Secret key', secret: true, optional: false }] },
  { id: 'custom', label: 'Something else', agents: 'all', link: null, note: null, fields: [] },
];

export function presetById(id) {
  return KEY_PRESETS.find(p => p.id === id) || null;
}

/** Variables an agent's own sign-in reads: giving one to an agent can change who pays, or how it signs in. */
export const signInVariables = {
  ANTHROPIC_API_KEY: 'Claude Code signs in with ANTHROPIC_API_KEY before your Claude subscription, so each request is billed to the key.',
  OPENAI_API_KEY: 'Codex may sign in with OPENAI_API_KEY, so each request is billed to the key.',
  CODEX_API_KEY: 'Codex signs in with CODEX_API_KEY before your ChatGPT account, so each request is billed to the key.',
  GEMINI_API_KEY: 'Gemini CLI may sign in with GEMINI_API_KEY instead of your Google account.',
  GH_TOKEN: 'Copilot CLI may sign in with GH_TOKEN.',
  GITHUB_TOKEN: 'Copilot CLI may sign in with GITHUB_TOKEN.',
};
