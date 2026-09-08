export type Envelope = {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  kind?: string;
  hint?: string;
  service?: string;
  event?: unknown;
};
