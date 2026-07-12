import { generateGQLensFiles } from "@gqlens/vite";
import { configureExampleLogging, getExampleLogger } from "../src/logging";
import { createSchemaSDL } from "../src/schema";

configureExampleLogging();

const logger = getExampleLogger("codegen");
const startedAt = performance.now();
const writeStats = await generateGQLensFiles({
  schema: createSchemaSDL(),
  framework: "react",
  output: "web/gqlens",
});

logger.info("Generated GQLens files in {durationMs}ms.", {
  durationMs: Math.round(performance.now() - startedAt),
  output: "web/gqlens",
  files: writeStats.total,
  changed: writeStats.changed,
  skipped: writeStats.skipped,
});
