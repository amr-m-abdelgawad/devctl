import { useCallback, useRef, useState } from "react";
import { postOperator } from "./api.ts";

export function useOperatorAction() {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const running = useRef(false);
  const run = useCallback(async <T>(action: string, args: Record<string, unknown> = {}): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setPending(action);
    setError("");
    try {
      const result = await postOperator<T>(action, args);
      window.dispatchEvent(new Event("devctl:refresh"));
      return result;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Action failed");
      return undefined;
    } finally {
      running.current = false;
      setPending("");
    }
  }, []);
  return { pending, error, run };
}
