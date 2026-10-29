import { expect, test } from "bun:test";
import { commandArguments } from "./command.ts";

test("exec preserves quoted and empty arguments without expanding shell syntax", () => {
  expect(commandArguments(`node -e 'console.log("hello world")' ""`)).toEqual(["node", "-e", 'console.log("hello world")', ""]);
  expect(commandArguments('echo "$HOME" foo\\ bar ;')).toEqual(["echo", "$HOME", "foo bar", ";"]);
  expect(() => commandArguments("node 'unfinished")).toThrow();
  expect(() => commandArguments(" ")).toThrow();
});
