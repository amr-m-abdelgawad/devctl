import type { UpdateCheck } from "../domain/update.ts";

export type UpdateApplyResult = { code: number; stdout: string; stderr: string };

export type UpdateChecker = {
  check(): Promise<UpdateCheck>;
};

export type UpdateInstaller = {
  apply(command: readonly string[], inherit?: boolean): Promise<UpdateApplyResult>;
};
