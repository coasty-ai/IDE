// The kinds of key a person can add in Agents & keys, and the variables each one sets. The page builds its "Add a
// key" form from these, and the key store (src/core/keys.mjs) reads them to know which fields are secret, which are
// optional, and which names get the same value.
//
// Pure: no node: modules. The page loads this file as it is (/shared/keypresets.mjs).
//
// A preset: { id, label, fields, agents, note, link }
//   fields  [{ name, label, secret, optional, also? }]: `name` is the variable; `also` lists names given the same
//           value. The `custom` preset has no fields: the person types names and values.
//   agents  who it suits: 'all', or a list of agent ids ('claude', 'codex'). The form starts "Given to" there.
//   note    a plain sentence shown with it, or null
//   link    where to make one (https only), or null

const field = (name, label, { secret = true, optional = false, also = null } = {}) =>
  Object.freeze({ name, label, secret, optional, ...(also ? { also: Object.freeze([...also]) } : {}) });

const preset = (id, label, fields, agents, note = null, link = null) =>
  Object.freeze({ id, label, fields: Object.freeze(fields), agents: Array.isArray(agents) ? Object.freeze([...agents]) : agents, note, link });

/** Said with the Anthropic key, and by the panel's "Use an API key" for Claude Code. */
export const ANTHROPIC_KEY_NOTE = 'Claude Code will use this key instead of your Claude subscription, and each request is billed to the key.';

export const KEY_PRESETS = Object.freeze([
  preset('anthropic', 'Anthropic', [field('ANTHROPIC_API_KEY', 'API key')], ['claude'], ANTHROPIC_KEY_NOTE),
  preset('openai', 'OpenAI', [field('OPENAI_API_KEY', 'API key', { also: ['CODEX_API_KEY'] })], ['codex']),
  preset('gemini', 'Gemini', [field('GEMINI_API_KEY', 'API key')], 'all'),
  preset('aws', 'AWS', [
    field('AWS_ACCESS_KEY_ID', 'Access key ID'),
    field('AWS_SECRET_ACCESS_KEY', 'Secret access key'),
    field('AWS_SESSION_TOKEN', 'Session token', { optional: true }),
    field('AWS_REGION', 'Region', { secret: false, optional: true }),
  ], 'all', 'Give agents a key that can do only what their work needs, never your root or admin keys.'),
  preset('google-cloud', 'Google Cloud', [
    field('GOOGLE_CLOUD_PROJECT', 'Project', { secret: false }),
    field('GOOGLE_API_KEY', 'API key', { optional: true }),
  ], 'all'),
  preset('azure', 'Azure', [
    field('AZURE_CLIENT_ID', 'Client ID', { secret: false }),
    field('AZURE_CLIENT_SECRET', 'Client secret'),
    field('AZURE_TENANT_ID', 'Tenant ID', { secret: false }),
    field('AZURE_SUBSCRIPTION_ID', 'Subscription ID', { secret: false, optional: true }),
  ], 'all'),
  preset('github', 'GitHub', [field('GH_TOKEN', 'Token', { also: ['GITHUB_TOKEN'] })], 'all', 'Copilot CLI may sign in with it.',
    'https://github.com/settings/tokens/new?description=Workbench&scopes=repo'),
  preset('stripe', 'Stripe', [field('STRIPE_SECRET_KEY', 'Secret key')], 'all'),
  preset('custom', 'Other', [], 'all'),
]);

/** The preset with this id, or null. */
export function presetById(id) {
  return KEY_PRESETS.find(p => p.id === id) || null;
}

/**
 * Variables that an agent's own sign-in reads. Giving one to an agent can change who pays for its requests, or which
 * account it signs in as, so the panel warns when a key sets one. NAME → { agents, sentence }: `agents` are the ids of
 * the agents whose sign-in reads it (some are agents Workbench does not run yet); `sentence` says what happens.
 */
export const signInVariables = Object.freeze(Object.fromEntries([
  ['ANTHROPIC_API_KEY', ['claude'], 'Claude Code will use ANTHROPIC_API_KEY instead of your Claude subscription, and each request is billed to the key.'],
  ['ANTHROPIC_AUTH_TOKEN', ['claude'], 'Claude Code will sign its requests with ANTHROPIC_AUTH_TOKEN instead of your Claude subscription.'],
  ['ANTHROPIC_BASE_URL', ['claude'], 'Claude Code will send its requests to the address in ANTHROPIC_BASE_URL.'],
  ['CLAUDE_CODE_USE_BEDROCK', ['claude'], 'With CLAUDE_CODE_USE_BEDROCK, Claude Code uses Amazon Bedrock, billed to your AWS account, instead of your Claude subscription.'],
  ['CLAUDE_CODE_USE_VERTEX', ['claude'], 'With CLAUDE_CODE_USE_VERTEX, Claude Code uses Google Cloud Vertex AI, billed to your Google Cloud account, instead of your Claude subscription.'],
  ['CLAUDE_CODE_USE_FOUNDRY', ['claude'], 'With CLAUDE_CODE_USE_FOUNDRY, Claude Code uses Microsoft Foundry, billed to your Azure account, instead of your Claude subscription.'],
  ['CODEX_API_KEY', ['codex'], 'Codex will use CODEX_API_KEY instead of your ChatGPT account, and each request is billed to the key.'],
  ['OPENAI_API_KEY', ['codex', 'goose', 'opencode', 'qwen-code'], 'Agents that use OpenAI may use OPENAI_API_KEY, and each request is billed to the key.'],
  ['OPENAI_BASE_URL', ['codex', 'qwen-code'], 'Agents that use OpenAI may send their requests to the address in OPENAI_BASE_URL.'],
  ['GEMINI_API_KEY', ['gemini', 'qwen-code'], 'Gemini CLI may switch to GEMINI_API_KEY instead of your Google sign-in.'],
  ['GOOGLE_API_KEY', ['gemini'], 'Gemini CLI may use GOOGLE_API_KEY instead of your Google sign-in.'],
  ['GOOGLE_CLOUD_PROJECT', ['gemini'], 'Gemini CLI may bill its requests to the Google Cloud project in GOOGLE_CLOUD_PROJECT.'],
  ['GOOGLE_APPLICATION_CREDENTIALS', ['gemini'], 'Gemini CLI may sign in with the file GOOGLE_APPLICATION_CREDENTIALS names.'],
  ['GOOGLE_GENAI_USE_VERTEXAI', ['gemini'], 'With GOOGLE_GENAI_USE_VERTEXAI, Gemini CLI uses Google Cloud Vertex AI instead of your Google sign-in.'],
  ['COPILOT_GITHUB_TOKEN', ['github-copilot-cli'], 'Copilot CLI may sign in with COPILOT_GITHUB_TOKEN.'],
  ['GH_TOKEN', ['github-copilot-cli'], 'Copilot CLI may sign in with GH_TOKEN.'],
  ['GITHUB_TOKEN', ['github-copilot-cli'], 'Copilot CLI may sign in with GITHUB_TOKEN.'],
  ['CURSOR_API_KEY', ['cursor'], 'Cursor may sign in with CURSOR_API_KEY.'],
].map(([name, agents, sentence]) => [name, Object.freeze({ agents: Object.freeze(agents), sentence })])));
