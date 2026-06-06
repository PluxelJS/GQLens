import { createServer } from "node:http";

import { createYogaHandler } from "./yoga";

const yoga = createYogaHandler();
const server = createServer(yoga);

server.listen(4000, () => {
  console.log("GraphQL server listening on http://localhost:4000/graphql");
});
