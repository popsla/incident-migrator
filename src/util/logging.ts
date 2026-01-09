class Logger {
  private debugEnabled = false;

  setDebug(enabled: boolean) {
    this.debugEnabled = enabled;
  }

  info(message: string, ...args: unknown[]) {
    console.log(`[INFO] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]) {
    console.warn(`[WARN] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]) {
    console.error(`[ERROR] ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]) {
    if (this.debugEnabled) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  success(message: string, ...args: unknown[]) {
    console.log(`[SUCCESS] ${message}`, ...args);
  }
}

export const logger = new Logger();
