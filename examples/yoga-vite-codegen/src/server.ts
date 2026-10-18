import { createHttpApp } from "./http-app";
import { configureExampleLogging, getExampleLogger } from "./logging";

configureExampleLogging();

const logger = getExampleLogger("server");
const app = createHttpApp();

const port = process.env.PORT === undefined ? 4000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535, received ${process.env.PORT}`);
}
const hostname = process.env.HOST ?? "127.0.0.1";
const origin = `http://${hostname}:${port}`;

app.listen({ port, hostname }, () => {
  logger.info("Elysia example server listening on {origin}.", {
    origin,
  });
  logger.info("GraphQL server listening on {endpoint}.", {
    endpoint: `${origin}/graphql`,
  });
});
