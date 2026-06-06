import type { PreparedSelection } from "@gqlens/core";
import { defineSelection, type QueryNode } from "./accessor";
import type * as Types from "./types";

export function readProfile(q: QueryNode): Types.Profile["handle"] | undefined {
  return q.profile({ id: "profile-1" }).handle;
}

export const profileSelection: PreparedSelection = defineSelection((q, v) => {
  void q.profile({ id: v("profileId") }).handle;
});
