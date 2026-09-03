import * as path from 'node:path';
import * as os from 'node:os';

const home = os.homedir();
const bernardHome = process.env.BERNARD_HOME;

function xdgBase(envVar: string, fallbackSuffix: string): string {
  if (bernardHome && path.isAbsolute(bernardHome)) return bernardHome;
  const envVal = process.env[envVar];
  // XDG spec: ignore relative paths
  if (envVal && path.isAbsolute(envVal)) return envVal;
  return path.join(home, fallbackSuffix);
}

const configBase = xdgBase('XDG_CONFIG_HOME', '.config');
const dataBase = xdgBase('XDG_DATA_HOME', path.join('.local', 'share'));
const cacheBase = xdgBase('XDG_CACHE_HOME', '.cache');
const stateBase = xdgBase('XDG_STATE_HOME', path.join('.local', 'state'));

// App-scoped roots
export const CONFIG_DIR = path.join(configBase, 'bernard');
export const DATA_DIR = path.join(dataBase, 'bernard');
export const CACHE_DIR = path.join(cacheBase, 'bernard');
export const STATE_DIR = path.join(stateBase, 'bernard');
export const LEGACY_DIR = path.join(home, '.bernard');

// Config
export const PREFS_PATH = path.join(CONFIG_DIR, 'preferences.json');
export const KEYS_PATH = path.join(CONFIG_DIR, 'keys.json');
export const ENV_PATH = path.join(CONFIG_DIR, '.env');
export const MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp.json');
export const CUSTOM_PROVIDERS_PATH = path.join(CONFIG_DIR, 'custom-providers.json');
export const LINEUPS_PATH = path.join(CONFIG_DIR, 'lineups.json');
export const PROFILES_PATH = path.join(CONFIG_DIR, 'profiles.json');
export const PROFILES_MIGRATED_MARKER = path.join(CONFIG_DIR, '.migrated-to-profiles');

// Data
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const RAG_DIR = path.join(DATA_DIR, 'rag');
export const MEMORIES_FILE = path.join(RAG_DIR, 'memories.json');
export const LAST_SESSION_FILE = path.join(RAG_DIR, 'last-session.txt');
export const CRON_DIR = path.join(DATA_DIR, 'cron');
export const CRON_JOBS_FILE = path.join(CRON_DIR, 'jobs.json');
export const CRON_ALERTS_DIR = path.join(CRON_DIR, 'alerts');
export const CRON_NOTES_DIR = path.join(CRON_DIR, 'notes');
/** Root for the per-run workspaces unattended writers may always write to (#340). */
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

/**
 * The workspace a scoped run may always write to.
 *
 * One convention in one place: `<namespace>/<stable id>`. Keyed on a *stable*
 * id (a cron job id, an app id) rather than a run id, because the point of a
 * workspace is that a job's output is still there on its next run. Each new
 * unattended writer inherits the layout instead of re-deriving it — and
 * retention, when it arrives, has one shape to prune rather than N.
 */
export function runWorkspace(namespace: string, id: string): string {
  return path.join(WORKSPACES_DIR, namespace, id);
}
export const ROUTINES_DIR = path.join(DATA_DIR, 'routines');
export const SPECIALISTS_DIR = path.join(DATA_DIR, 'specialists');
/** One `<appId>.json` manifest per applet-style app (#419). */
export const APPS_DIR = path.join(DATA_DIR, 'apps');
/**
 * An applet's served assets: `APPS_DIR/<appId>/index.html` and friends (#421).
 *
 * A sibling directory of the manifest, and deliberately NOT
 * `runWorkspace('apps', appId)` — that is where an applet action may write
 * *data*. Serving an applet's *code* from its own write scope would let an
 * action rewrite the page it is served from.
 */
export function appletAssetDir(appId: string): string {
  return path.join(APPS_DIR, appId);
}
export const SPECIALIST_CANDIDATES_DIR = path.join(DATA_DIR, 'specialist-candidates');
export const CORRECTION_CANDIDATES_DIR = path.join(DATA_DIR, 'correction-candidates');
export const TOOL_PROFILES_DIR = path.join(DATA_DIR, 'tool-profiles');

// Cache
export const MODELS_DIR = path.join(CACHE_DIR, 'models');
export const UPDATE_CACHE_PATH = path.join(CACHE_DIR, 'update-check.json');
export const MODEL_CATALOG_CACHE = path.join(CACHE_DIR, 'model-catalog.json');

// State
export const HISTORY_FILE = path.join(STATE_DIR, 'conversation-history.json');
export const PROVENANCE_HISTORY_FILE = path.join(STATE_DIR, 'provenance-history.json');
export const TURN_CONTEXT_FILE = path.join(STATE_DIR, 'turn-context.json');
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const SESSION_LOGS_DIR = path.join(LOGS_DIR, 'sessions');
export const TOOL_WRAPPER_LOG = path.join(LOGS_DIR, 'tool-wrappers.jsonl');
/** Append-only record of every `bernard script` invocation (#419). */
export const SCRIPT_LOG_FILE = path.join(LOGS_DIR, 'script-invocations.jsonl');
/** Per-session LLM cost/usage telemetry JSONL, one file per session id. */
export const TELEMETRY_DIR = path.join(LOGS_DIR, 'telemetry');
export function sessionTelemetryPath(sessionId: string): string {
  return path.join(TELEMETRY_DIR, `${sessionId}.jsonl`);
}
export const CRON_PID_FILE = path.join(STATE_DIR, 'cron-daemon.pid');
export const CRON_LOG_FILE = path.join(STATE_DIR, 'cron-daemon.log');
/** Applet host process state (#421), mirroring the cron daemon's pair. */
export const APPLET_HOST_PID_FILE = path.join(STATE_DIR, 'applet-host.pid');
export const APPLET_HOST_LOG_FILE = path.join(STATE_DIR, 'applet-host.log');
/**
 * Per-applet port and session token (#421).
 *
 * State rather than config: machine-local and regenerable. Kept out of the
 * manifest on purpose — `AppManifestSchema` is `.strict()` with
 * `schemaVersion: z.literal(1)`, so a new field there makes an older binary
 * reject the whole app; the manifest is bundle-seeded and user-editable, so a
 * token in it is settable by any local process; and it is validated on read,
 * i.e. trusted at exactly the wrong moment.
 */
export const APPLET_HOSTS_FILE = path.join(STATE_DIR, 'applet-hosts.json');
