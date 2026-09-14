export type HttpRecipeSnapshot = {
  status: number;
  body: string;
  contentType: string;
  values: Record<string, string>;
  expiresAt?: Date;
};

export type HttpRecipeRuntime = {
  ensure(name: string): Promise<HttpRecipeSnapshot>;
  snapshot(name: string): HttpRecipeSnapshot | undefined;
  start(): void;
  stop(): void;
  reset(): void;
};
