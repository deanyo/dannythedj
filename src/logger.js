const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const DEFAULT_LEVEL = 'info';

let currentLevel = normalizeLevel(process.env.LOG_LEVEL) || DEFAULT_LEVEL;

function normalizeLevel(input) {
  if (!input) {
    return null;
  }
  const key = String(input).toLowerCase();
  return LEVELS[key] !== undefined ? key : null;
}

function setLevel(level) {
  const normalized = normalizeLevel(level);
  if (!normalized) {
    return false;
  }
  currentLevel = normalized;
  return true;
}

function getLevel() {
  return currentLevel;
}

function shouldLog(level) {
  return LEVELS[level] <= LEVELS[currentLevel];
}

function debug(message, ...args) {
  if (shouldLog('debug')) {
    console.log(message, ...args);
  }
}

function info(message, ...args) {
  if (shouldLog('info')) {
    console.log(message, ...args);
  }
}

function warn(message, ...args) {
  if (shouldLog('warn')) {
    console.warn(message, ...args);
  }
}

function error(message, ...args) {
  if (shouldLog('error')) {
    console.error(message, ...args);
  }
}

module.exports = {
  debug,
  info,
  warn,
  error,
  getLevel,
  setLevel
};
