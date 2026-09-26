import { describe, expect, test } from "bun:test";
import { matchGrpcOk } from "./grpc-ok.ts";

const pollPath = "/temporal.api.workflowservice.v1.WorkflowService/PollWorkflowTaskQueue";
const completePath = "/temporal.api.workflowservice.v1.WorkflowService/RespondWorkflowTaskCompleted";
const captured = { log: "info" as const, inspect: true };
const silent = { log: "silent" as const, inspect: true };

describe("matchGrpcOk", () => {
  test("returns undefined when no rules match", () => {
    expect(matchGrpcOk(undefined, 14, pollPath)).toBeUndefined();
    expect(matchGrpcOk([], 14, pollPath)).toBeUndefined();
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], 7, pollPath)).toBeUndefined();
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], 14, completePath)).toBeUndefined();
  });

  test("matches a listed status as a :path suffix", () => {
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue", "PollActivityTaskQueue"] }], 14, pollPath)).toEqual(captured);
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], "14", pollPath)).toEqual(captured);
    expect(matchGrpcOk([{ status: 14, methods: ["/PollWorkflowTaskQueue"] }], 14, pollPath)).toEqual(captured);
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], 14, "/svc/NotPollWorkflowTaskQueue")).toBeUndefined();
  });

  test("omit methods applies to every method on the route", () => {
    expect(matchGrpcOk([{ status: 14 }], 14, "/any.Service/Whatever")).toEqual(captured);
    expect(matchGrpcOk([{ status: 14, methods: [] }], 14, completePath)).toEqual(captured);
  });

  test("log: silent wins over the info default", () => {
    expect(matchGrpcOk([{ status: 3, methods: ["RespondWorkflowTaskCompleted"], log: "silent" }], 3, completePath)).toEqual(silent);
    expect(matchGrpcOk([{ status: 3, methods: ["RespondWorkflowTaskCompleted"], log: "info" }], 3, completePath)).toEqual(captured);
  });

  test("status 0 matches and inspect: false skips capture", () => {
    expect(matchGrpcOk([{ status: 0, methods: ["PollWorkflowTaskQueue"], log: "silent", inspect: false }], 0, pollPath)).toEqual({
      log: "silent",
      inspect: false,
    });
    expect(matchGrpcOk([{ status: 0, methods: ["PollWorkflowTaskQueue"], inspect: true }], 0, pollPath)).toEqual(captured);
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"], inspect: false }], 14, completePath)).toBeUndefined();
  });
});
