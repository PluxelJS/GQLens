import type { MutationOperation, PreparedSelection } from "@gqlens/core";
import { api, defineSelection, type QueryNode } from "./accessor";
import type { InvalidationSpec } from "./invalidation";
import type * as Types from "./types";

export function readReports(q: QueryNode): {
  readonly reportIds: readonly string[] | undefined;
  readonly title: Types.Report["title"] | undefined;
} {
  return {
    reportIds: q.reports({
      filter: {
        text: "release",
        tags: ["stable"],
        range: { from: "2026-01-01T00:00:00Z" },
        order: "DESC",
      },
      ids: ["report-1"],
      limit: 5,
    }).ids,
    title: q.latestReport.title,
  };
}

export const filterSelection: PreparedSelection = defineSelection((q, v) => {
  void q.reports({
    filter: {
      text: v("text"),
      tags: [v("tag")],
      range: { from: v("from"), to: v("to") },
      order: v("order"),
    },
    ids: [v("id")],
    limit: v("limit"),
  }).ids;
});

export const ping: MutationOperation<Record<string, unknown>, Types.Mutation["ping"]> = api.mutation
  .ping;

export const rebuildIndex: MutationOperation<
  Record<string, unknown>,
  Types.Mutation["rebuildIndex"]
> = api.mutation.rebuildIndex;

export const renameReport: MutationOperation<Types.MutationRenameReportArgs, Types.Report> =
  api.report.rename;

export const createAudit: MutationOperation<Types.MutationCreateAuditArgs, Types.AuditEvent> =
  api.audit.create;

export const typedInvalidation: InvalidationSpec = {
  type: "Report",
  id: "report-1",
  keys: ["title", "createdAt"],
};
