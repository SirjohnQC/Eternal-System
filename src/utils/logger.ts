const PREFIX = '[ETERNAL]';

export const logger = {
  info:  (msg: string, ...args: unknown[]) => console.info(`${PREFIX} ${msg}`, ...args),
  warn:  (msg: string, ...args: unknown[]) => console.warn(`${PREFIX} ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`${PREFIX} ${msg}`, ...args),
  god:   (msg: string, ...args: unknown[]) => console.log(`%c[GOD] ${msg}`, 'color:#c8a96e;font-style:italic', ...args),
};
