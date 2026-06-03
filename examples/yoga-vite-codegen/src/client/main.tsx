import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GQLensProvider } from "@gqlens/react";

import { useQuery } from "../gqlens/accessor";
import { graphqlFetcher } from "./graphql-fetcher";

function ViewerName() {
  const q = useQuery();
  return <p>Viewer: {q.viewer.name}</p>;
}

function App() {
  return (
    <GQLensProvider config={{ fetcher: graphqlFetcher }}>
      <ViewerName />
    </GQLensProvider>
  );
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
