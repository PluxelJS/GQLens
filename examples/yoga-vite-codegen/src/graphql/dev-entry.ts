import { createYogaHandler } from "./yoga";

export async function createNodeHandler() {
  return createYogaHandler();
}

if (import.meta.hot) {
  import.meta.hot.accept();

  import.meta.hot.dispose(() => {
    // The dev db singleton is owned by the process lifetime.
  });
}
