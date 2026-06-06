import { generateFiles } from "../../../packages/codegen/src/index";
import { createSchemaSDL } from "../src/graphql/schema";
import { writeGeneratedFiles } from "./write-generated-files";

const files = await generateFiles({
  schema: createSchemaSDL(),
  framework: "react",
});

await writeGeneratedFiles(files, "src/gqlens");
