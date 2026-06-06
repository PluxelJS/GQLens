import { generateFiles } from "../../../packages/codegen/src/index";
import { configureExampleLogging, getExampleLogger } from "../src/logging";
import { createSchemaSDL } from "../src/schema";
import { writeGeneratedFiles } from "./write-generated-files";

configureExampleLogging();

const logger = getExampleLogger("codegen");
const startedAt = performance.now();
const files = await generateFiles({
  schema: createSchemaSDL(),
  framework: "react",
});

const writeStats = await writeGeneratedFiles(files, "web/gqlens");
logger.info("Generated GQLens files in {durationMs}ms.", {
  durationMs: Math.round(performance.now() - startedAt),
  output: "web/gqlens",
  files: writeStats.total,
  changed: writeStats.changed,
  skipped: writeStats.skipped,
});
