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

// Data
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const RAG_DIR = path.join(DATA_DIR, 'rag');
export const MEMORIES_FILE = path.join(RAG_DIR, 'memories.json');
export const LAST_SESSION_FILE = path.join(RAG_DIR, 'last-session.txt');
export const CRON_DIR = path.join(DATA_DIR, 'cron');
export const CRON_JOBS_FILE = path.join(CRON_DIR, 'jobs.json');
export const CRON_ALERTS_DIR = path.join(CRON_DIR, 'alerts');
export const ROUTINES_DIR = path.join(DATA_DIR, 'routines');

// Cache
export const MODELS_DIR = path.join(CACHE_DIR, 'models');
export const UPDATE_CACHE_PATH = path.join(CACHE_DIR, 'update-check.json');

// State
export const HISTORY_FILE = path.join(STATE_DIR, 'conversation-history.json');
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const CRON_PID_FILE = path.join(STATE_DIR, 'cron-daemon.pid');
export const CRON_LOG_FILE = path.join(STATE_DIR, 'cron-daemon.log');
