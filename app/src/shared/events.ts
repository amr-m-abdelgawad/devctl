export const ServiceStarted = "ServiceStarted";
export const ServiceStopped = "ServiceStopped";
export const ServiceFailed = "ServiceFailed";
export const ServiceStateChanged = "ServiceStateChanged";
export const ServiceHealthChanged = "ServiceHealthChanged";
export const LogReceived = "LogReceived";
export const TokenRefreshed = "TokenRefreshed";
export const TokenRefreshFailed = "TokenRefreshFailed";
export const AuthenticationChanged = "AuthenticationChanged";
export const ProxyStarted = "ProxyStarted";
export const ProxyStopped = "ProxyStopped";
export const ProxyRequest = "ProxyRequest";
export const ConfigurationChanged = "ConfigurationChanged";
export const ConfigurationReloadFailed = "ConfigurationReloadFailed";
export const SessionRecovered = "SessionRecovered";

export type EventType =
  | typeof ServiceStarted
  | typeof ServiceStopped
  | typeof ServiceFailed
  | typeof ServiceStateChanged
  | typeof ServiceHealthChanged
  | typeof LogReceived
  | typeof TokenRefreshed
  | typeof TokenRefreshFailed
  | typeof AuthenticationChanged
  | typeof ProxyStarted
  | typeof ProxyStopped
  | typeof ProxyRequest
  | typeof ConfigurationChanged
  | typeof ConfigurationReloadFailed
  | typeof SessionRecovered
  | string;

export type BusEvent = {
  type: EventType;
  timestamp: string;
  service?: string;
  payload?: Record<string, unknown>;
};

export type EventHandler = (event: BusEvent) => void;

export function newEvent(type: EventType, service: string, payload?: Record<string, unknown>): BusEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    service,
    payload,
  };
}

export class Bus {
  private readonly subs = new Map<number, { types: Set<EventType>; handler: EventHandler }>();
  private nextID = 0;
  private buffer: BusEvent[] = [];
  private readonly maxBuf: number;

  constructor(maxBuffer: number) {
    this.maxBuf = maxBuffer > 0 ? maxBuffer : 1024;
  }

  subscribe(handler: EventHandler, types: EventType[] = []): () => void {
    this.nextID += 1;
    const id = this.nextID;
    this.subs.set(id, { types: new Set(types), handler });
    return () => {
      this.subs.delete(id);
    };
  }

  publish(event: BusEvent): void {
    const ev = event.timestamp === "" ? { ...event, timestamp: new Date().toISOString() } : event;
    if (this.buffer.length >= this.maxBuf) {
      this.buffer = this.buffer.slice(1);
    }
    this.buffer.push(ev);
    for (const sub of this.subs.values()) {
      if (sub.types.size === 0 || sub.types.has(ev.type)) {
        sub.handler(ev);
      }
    }
  }

  recent(): BusEvent[] {
    return [...this.buffer];
  }
}
