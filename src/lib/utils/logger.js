const formatPrefix = (namespace, level) =>
  `[${new Date().toISOString()}][${namespace ?? 'wallet'}][${level.toUpperCase()}]`;

const resolveConsoleMethod = (level) => {
  switch (level) {
    case 'trace':
      return console.trace;
    case 'debug':
      return console.debug;
    case 'info':
      return console.info;
    case 'warn':
      return console.warn;
    case 'error':
      return console.error;
    default:
      return console.log;
  }
};

export const createLogger = (namespace = 'wallet') => {
  const log = (level) => (...args) => {
    const handler = resolveConsoleMethod(level).bind(console);
    handler(formatPrefix(namespace, level), ...args);
  };

  return {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error')
  };
};

