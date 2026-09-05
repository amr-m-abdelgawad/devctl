import { newError, KindConfiguration } from "../../shared/errors.ts";
import {
  StateFailed,
  StateHealthy,
  StateRestarting,
  StateRunning,
  StateStarting,
  StateStopped,
  StateStopping,
  StateUnknown,
  StateUnhealthy,
  type ServiceState,
} from "./services.ts";

const ACTIVE: readonly ServiceState[] = [StateStopping, StateFailed, StateRestarting, StateRunning, StateStopped];

export const LEGAL_TRANSITIONS: Readonly<Record<ServiceState, readonly ServiceState[]>> = {
  [StateUnknown]: [StateStopped, StateStarting, StateRunning, StateFailed, StateRestarting, StateStopping],
  [StateStopped]: [StateStarting, StateRunning, StateFailed],
  [StateStarting]: [StateRunning, StateFailed, StateStopped, StateStopping],
  [StateRunning]: ACTIVE,
  [StateHealthy]: ACTIVE,
  [StateUnhealthy]: ACTIVE,
  [StateStopping]: [StateStopped, StateFailed],
  [StateFailed]: [StateStarting, StateStopped, StateRunning],
  [StateRestarting]: [StateStarting, StateRunning, StateFailed, StateStopped],
};

export function canTransition(from: ServiceState, to: ServiceState): boolean {
  if (from === to) {
    return true;
  }
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

export function transition(from: ServiceState, to: ServiceState): ServiceState {
  if (!canTransition(from, to)) {
    throw newError(KindConfiguration, `illegal service lifecycle transition ${from} → ${to}`);
  }
  return to;
}
