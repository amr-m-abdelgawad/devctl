import { describe, expect, test } from "bun:test";
import { matchGrpcOk } from "./grpc-ok.ts";

const pollPath = "/temporal.api.workflowservice.v1.WorkflowService/PollWorkflowTaskQueue";
const completePath = "/temporal.api.workflowservice.v1.WorkflowService/RespondWorkflowTaskCompleted";

describe("matchGrpcOk", () => {
  test("returns undefined when no rules match", () => {
    expect(matchGrpcOk(undefined, 14, pollPath)).toBeUndefined();
    expect(matchGrpcOk([], 14, pollPath)).toBeUndefined();
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], 7, pollPath)).toBeUndefined();
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], 14, completePath)).toBeUndefined();
  });

  test("matches a listed status as a :path suffix", () => {
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue", "PollActivityTaskQueue"] }], 14, pollPath)).toBe("info");
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], "14", pollPath)).toBe("info");
    expect(matchGrpcOk([{ status: 14, methods: ["/PollWorkflowTaskQueue"] }], 14, pollPath)).toBe("info");
    expect(matchGrpcOk([{ status: 14, methods: ["PollWorkflowTaskQueue"] }], 14, "/svc/NotPollWorkflowTaskQueue")).toBeUndefined();
  });

  test("omit methods applies to every method on the route", () => {
    expect(matchGrpcOk([{ status: 14 }], 14, "/any.Service/Whatever")).toBe("info");
    expect(matchGrpcOk([{ status: 14, methods: [] }], 14, completePath)).toBe("info");
  });

  test("log: silent wins over the info default", () => {
    expect(matchGrpcOk([{ status: 3, methods: ["RespondWorkflowTaskCompleted"], log: "silent" }], 3, completePath)).toBe("silent");
    expect(matchGrpcOk([{ status: 3, methods: ["RespondWorkflowTaskCompleted"], log: "info" }], 3, completePath)).toBe("info");
  });
});
