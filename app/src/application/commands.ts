import type { DevctlConfig } from "../domain/config/types.ts";
import { startupPlan, shutdownPlan, resolveStartRequest, type Plan } from "../domain/service/services.ts";
import type { StartRequest, StatusSnapshot, ReloadResult } from "../types.ts";
import type { DoctorRunner } from "../ports/doctor-runner.ts";
import type { DoctorProgress, DoctorRuntimeContext, Report } from "../domain/doctor/types.ts";
import { serviceId, type ServiceId } from "../domain/ids.ts";
import type { ServiceOrchestrator } from "./orchestrator.ts";

export type ServiceCommandHost = {
  start(req: StartRequest): Promise<Plan>;
  stop(names: string[]): Promise<void>;
  restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void>;
  reload(): Promise<ReloadResult>;
  snapshot(): StatusSnapshot;
  startProxy(): Promise<void>;
  stopProxy(): Promise<void>;
  refreshIdentity(opts?: { probeServiceAccounts?: boolean }): Promise<void>;
};

export type StartStop = {
  start(req: StartRequest): Promise<Plan>;
  stop(names: string[]): Promise<void>;
  restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void>;
};

export class StartService {
  constructor(private readonly start: (req: StartRequest) => Promise<Plan>) {}
  execute(req: StartRequest): Promise<Plan> {
    return this.start({
      ...req,
      services: req.services?.map((name) => asServiceId(name)),
    });
  }
}

export class StopService {
  constructor(private readonly stop: (names: string[]) => Promise<void>) {}
  execute(names: string[]): Promise<void> {
    return this.stop(names.map((name) => asServiceId(name)));
  }
}

export class RestartService {
  constructor(private readonly restart: (names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }) => Promise<void>) {}
  execute(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string> }): Promise<void> {
    return this.restart(names.map((name) => asServiceId(name)), opts);
  }
}

export class StartProfile {
  constructor(private readonly start: StartService) {}
  execute(profile: string, clientEnv?: Record<string, string>): Promise<Plan> {
    return this.start.execute({ profile, client_env: clientEnv });
  }
}

export class StartProxy {
  constructor(private readonly host: ServiceCommandHost) {}
  execute(): Promise<void> {
    return this.host.startProxy();
  }
}

export class StopProxy {
  constructor(private readonly host: ServiceCommandHost) {}
  execute(): Promise<void> {
    return this.host.stopProxy();
  }
}

export class ReloadConfig {
  constructor(private readonly host: ServiceCommandHost) {}
  execute(): Promise<ReloadResult> {
    return this.host.reload();
  }
}

export class RefreshIdentity {
  constructor(private readonly host: ServiceCommandHost) {}
  execute(): Promise<void> {
    return this.host.refreshIdentity({ probeServiceAccounts: true });
  }
}

export class RunDoctor {
  constructor(private readonly runner: DoctorRunner) {}
  execute(cfg: DevctlConfig, onProgress?: (progress: DoctorProgress) => void, runtime?: DoctorRuntimeContext): Promise<Report> {
    return this.runner.run(cfg, onProgress, runtime);
  }
}

export class GetStartupPlan {
  execute(cfg: DevctlConfig, selected: string[], profile: string): Plan {
    return startupPlan(cfg, selected, profile);
  }
}

export class GetShutdownPlan {
  execute(cfg: DevctlConfig, selected: string[]): Plan {
    return shutdownPlan(cfg, selected);
  }
}

export class GetServiceStatus {
  constructor(private readonly host: ServiceCommandHost) {}
  execute(): StatusSnapshot {
    return this.host.snapshot();
  }
}

export class GetConfigSnapshot {
  constructor(private readonly load: (repoRoot: string, configPath: string) => DevctlConfig) {}
  execute(repoRoot: string, configPath: string): DevctlConfig {
    return this.load(repoRoot, configPath);
  }
}

export class ResolveStart {
  execute(cfg: DevctlConfig, req: { services?: string[]; profile?: string; activeProfile?: string }) {
    return resolveStartRequest(cfg, req);
  }
}

export function asServiceId(name: string): ServiceId {
  return serviceId(name);
}

export type ApplicationCommands = {
  startService: StartService;
  stopService: StopService;
  restartService: RestartService;
  startProfile: StartProfile;
  startProxy: StartProxy;
  stopProxy: StopProxy;
  reloadConfig: ReloadConfig;
  refreshIdentity: RefreshIdentity;
  runDoctor: RunDoctor;
  getServiceStatus: GetServiceStatus;
  getStartupPlan: GetStartupPlan;
  getShutdownPlan: GetShutdownPlan;
  resolveStart: ResolveStart;
};

export function commandsForHost(host: ServiceCommandHost, doctor: DoctorRunner, orchestrator?: ServiceOrchestrator): ApplicationCommands {
  const startStop: StartStop = orchestrator ?? host;
  const startService = new StartService((req) => startStop.start(req));
  return {
    startService,
    stopService: new StopService((names) => startStop.stop(names)),
    restartService: new RestartService((names, opts) => startStop.restart(names, opts)),
    startProfile: new StartProfile(startService),
    startProxy: new StartProxy(host),
    stopProxy: new StopProxy(host),
    reloadConfig: new ReloadConfig(host),
    refreshIdentity: new RefreshIdentity(host),
    runDoctor: new RunDoctor(doctor),
    getServiceStatus: new GetServiceStatus(host),
    getStartupPlan: new GetStartupPlan(),
    getShutdownPlan: new GetShutdownPlan(),
    resolveStart: new ResolveStart(),
  };
}
