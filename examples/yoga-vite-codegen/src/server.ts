import { createHttpApp } from "./http-app";
import { configureExampleLogging, getExampleLogger } from "./logging";

configureExampleLogging();

const logger = getExampleLogger("server");
const app = createHttpApp();

app.listen(4000, () => {
  logger.info("Elysia example server listening on {origin}.", {
    origin: "http://localhost:4000",
  });
  logger.info("GraphQL server listening on {endpoint}.", {
    endpoint: "http://localhost:4000/graphql",
  });
});
