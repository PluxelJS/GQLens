import { createServer } from "node:http";

import { configureExampleLogging, getExampleLogger } from "./logging";
import { createYogaHandler } from "./yoga";

configureExampleLogging();

const logger = getExampleLogger("server");
const yoga = createYogaHandler();
const server = createServer(yoga);

server.listen(4000, () => {
  logger.info("GraphQL server listening on {endpoint}.", {
    endpoint: "http://localhost:4000/graphql",
  });
});
