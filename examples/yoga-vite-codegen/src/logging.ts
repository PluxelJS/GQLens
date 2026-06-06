import {
  configureSync,
  getConfig,
  getConsoleSink,
  getLogger,
  isLogLevel,
  type Logger,
  type LogLevel,
} from "@logtape/logtape";

const rootCategory = "gqlens-example";

export function configureExampleLogging(): void {
  if (getConfig()) {
    return;
  }

  configureSync({
    sinks: {
      console: getConsoleSink(),
    },
    loggers: [
      {
        category: rootCategory,
        sinks: ["console"],
        lowestLevel: logLevelFromEnv(),
      },
      {
        category: ["logtape", "meta"],
        sinks: ["console"],
        lowestLevel: "warning",
      },
    ],
  });
}

export function getExampleLogger(category: string | readonly string[]): Logger {
  const suffix = typeof category === "string" ? [category] : category;
  return getLogger([rootCategory, ...suffix]);
}

function logLevelFromEnv(): LogLevel | null {
  const value = process.env.GQLENS_EXAMPLE_LOG_LEVEL ?? "info";
  if (value === "off") {
    return null;
  }
  return isLogLevel(value) ? value : "info";
}
