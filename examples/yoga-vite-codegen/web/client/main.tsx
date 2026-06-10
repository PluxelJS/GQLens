import { StrictMode, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { GQLensProvider, useMutation } from "@gqlens/react";

import { api, defineInvalidation, useQuery } from "../gqlens/accessor";
import { graphqlFetcher } from "./graphql-fetcher";
import "./styles.css";

const demoPostId = "p1";
const postCommentsInvalidation = defineInvalidation((q) => q.post({ id: demoPostId }).comments.ids);

function Dashboard() {
  const q = useQuery();
  const addComment = useMutation(api.comment.add);
  const toggleViewer = useMutation(api.userOnline.toggle);
  const [commentBody, setCommentBody] = useState("Verified from the GQLens demo UI.");
  const [mutationState, setMutationState] = useState("ready");

  const userIds = q.users.ids ?? [];
  const postIds = q.posts.ids ?? [];
  const viewerPostIds = q.viewer.posts.ids ?? [];
  const demoCommentIds = q.post({ id: demoPostId }).comments.ids ?? [];

  const invalidates = useMemo(() => [postCommentsInvalidation], []);

  async function handleAddComment(): Promise<void> {
    setMutationState("adding comment");
    await addComment({ postId: demoPostId, body: commentBody, invalidates });
    setCommentBody("");
    setMutationState("comment added");
  }

  async function handleToggleViewer(): Promise<void> {
    setMutationState("toggling viewer");
    await toggleViewer({
      id: "u1",
      invalidates: [{ type: "User", id: "u1", keys: ["online"] }],
    });
    setMutationState("viewer toggled");
  }

  return (
    <main className="app-shell">
      <section className="summary-band">
        <div>
          <h1>GQLens Yoga demo</h1>
          <p>
            Schema codegen, React accessors, GraphDataStore, Yoga resolvers, and mutation
            descriptors are all exercised here.
          </p>
        </div>
        <div className="status-card" data-testid="viewer-status">
          <span>Viewer</span>
          <strong>{q.viewer.name ?? "loading"}</strong>
          <small>{q.viewer.online ? "online" : "offline"}</small>
        </div>
      </section>

      <section className="grid">
        <Panel title="Users" meta={`${userIds.length} ids from q.users.ids`}>
          <ul className="stack-list" data-testid="user-list">
            {userIds.map((id) => {
              const user = q.user({ id });
              return (
                <li key={id}>
                  <strong>{user.name ?? id}</strong>
                  <span>{user.role ?? "..."}</span>
                  <span>{user.online ? "online" : "offline"}</span>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel title="Posts" meta={`${postIds.length} ids from q.posts.ids`}>
          <ul className="stack-list" data-testid="post-list">
            {postIds.map((id) => {
              const post = q.post({ id });
              return (
                <li key={id}>
                  <strong>{post.title ?? id}</strong>
                  <span>{post.author.name ?? "loading author"}</span>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel title="Relations" meta="viewer.posts and post.comments">
          <dl className="facts">
            <div>
              <dt>Viewer posts</dt>
              <dd data-testid="viewer-post-count">{viewerPostIds.length}</dd>
            </div>
            <div>
              <dt>Demo post comments</dt>
              <dd data-testid="comment-count">{demoCommentIds.length}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Generated mutations" meta="api.comment.add / api.userOnline.toggle">
          <label className="field">
            <span>Comment body</span>
            <input value={commentBody} onChange={(event) => setCommentBody(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => void handleAddComment()}>
              Add comment
            </button>
            <button type="button" onClick={() => void handleToggleViewer()}>
              Toggle viewer
            </button>
          </div>
          <p className="muted" data-testid="mutation-state">
            {mutationState}
          </p>
        </Panel>
      </section>
    </main>
  );
}

function Panel(props: {
  readonly title: string;
  readonly meta: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="panel">
      <header>
        <h2>{props.title}</h2>
        <span>{props.meta}</span>
      </header>
      {props.children}
    </section>
  );
}

function App() {
  return (
    <GQLensProvider config={{ fetcher: graphqlFetcher }}>
      <Dashboard />
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
