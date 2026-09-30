import { describe, expect, test } from "bun:test";
import { BodyBudget, textBytes } from "./body-store.ts";

describe("BodyBudget", () => {
  test("evicts the oldest bodies first and keeps the total under the budget", () => {
    const budget = new BodyBudget(100);
    expect(budget.put("a", 40)).toEqual([]);
    expect(budget.put("b", 40)).toEqual([]);
    expect(budget.put("c", 40)).toEqual(["a"]);
    expect(budget.byteSize()).toBe(80);
  });

  test("re-putting an id replaces its size and makes it the newest", () => {
    const budget = new BodyBudget(100);
    budget.put("a", 40);
    budget.put("b", 40);
    expect(budget.put("a", 50)).toEqual([]);
    expect(budget.byteSize()).toBe(90);
    expect(budget.put("c", 40)).toEqual(["b"]);
  });

  test("refuses a body larger than the whole budget without evicting the rest", () => {
    const budget = new BodyBudget(100);
    budget.put("a", 60);
    expect(budget.put("big", 101)).toEqual(["big"]);
    expect(budget.byteSize()).toBe(60);
  });

  test("drop and shedAll release exactly what was recorded", () => {
    const budget = new BodyBudget(100);
    budget.put("a", 10);
    budget.put("b", 20);
    expect(budget.put("empty", 0)).toEqual([]);
    budget.drop("a");
    budget.drop("missing");
    expect(budget.byteSize()).toBe(20);
    expect(budget.shedAll()).toEqual(["b"]);
    expect(budget.byteSize()).toBe(0);
  });
});

describe("textBytes", () => {
  test("counts two bytes per unit once a string holds a character outside Latin-1", () => {
    expect(textBytes(undefined)).toBe(0);
    expect(textBytes("")).toBe(0);
    expect(textBytes("plain ascii")).toBe(11);
    expect(textBytes("café")).toBe(4);
    expect(textBytes("it’s")).toBe(8);
  });
});
