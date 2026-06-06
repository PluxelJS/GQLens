import { generateFiles } from "../../../packages/codegen/src/index";
import { createSchemaSDL } from "../src/schema";
import { writeGeneratedFiles } from "./write-generated-files";

const files = await generateFiles({
  schema: createSchemaSDL(),
  framework: "react",
});

await writeGeneratedFiles(files, "web/gqlens");
