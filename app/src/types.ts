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
  // Client → supervisor only. Never echoed on responses or events.
  auth?: string;
};
