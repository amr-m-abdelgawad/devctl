import { useEffect, useState } from "react";

type Job = {
  id: number;
  title: string;
  owner: string;
  status: string;
};

type Health = { status?: string; service?: string };

export function App() {
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("index invoices");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [auth, setAuth] = useState<Health>({});
  const [api, setApi] = useState<Health>({});
  const [error, setError] = useState("");

  const load = async (nextToken = token) => {
    const [authRes, apiRes, jobsRes] = await Promise.all([
      fetch("/auth/health").then((res) => res.json() as Promise<Health>),
      fetch("/api/health").then((res) => res.json() as Promise<Health>),
      fetch("/api/jobs").then((res) => res.json() as Promise<{ jobs?: Job[] }>),
    ]);
    setAuth(authRes);
    setApi(apiRes);
    setJobs(jobsRes.jobs ?? []);
    if (nextToken) {
      const me = await fetch("/auth/whoami", { headers: { Authorization: `Bearer ${nextToken}` } });
      if (me.ok) {
        const body = (await me.json()) as { user?: string };
        setUser(body.user ?? "");
      }
    }
  };

  useEffect(() => {
    void load(token).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    const timer = setInterval(() => {
      void load(token).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [token]);

  const signIn = async () => {
    setError("");
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "ada@example.com" }),
    });
    const body = (await res.json()) as { token?: string; user?: string; error?: string };
    if (!res.ok || !body.token) {
      setError(body.error || "login failed");
      return;
    }
    setToken(body.token);
    setUser(body.user ?? "");
    await load(body.token);
  };

  const enqueue = async () => {
    setError("");
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      setError(body.error || "could not queue job");
      return;
    }
    await load();
  };

  return (
    <div className="app">
      <header>
        <h1>Billing Console</h1>
        <p>Admin console talking to the identity and invoices-api services.</p>
      </header>
      <div className="grid">
        <section className="card">
          <h2>identity · python</h2>
          <p className="status">{auth.service ? `${auth.service} ${auth.status}` : "waiting for 127.0.0.1:18001"}</p>
          <div className="row">
            <button type="button" onClick={() => void signIn()}>
              Sign in as ada
            </button>
          </div>
          <p className="muted">{user ? `session ${user}` : "not signed in"}</p>
        </section>
        <section className="card">
          <h2>invoices-api · python</h2>
          <p className="status">{api.service ? `${api.service} ${api.status}` : "waiting for 127.0.0.1:18000"}</p>
          <div className="row">
            <input value={title} onChange={(ev) => setTitle(ev.target.value)} aria-label="job title" />
            <button type="button" className="secondary" onClick={() => void enqueue()}>
              Queue job
            </button>
          </div>
        </section>
      </div>
      <section className="card">
        <h2>invoice jobs</h2>
        {error ? <p className="error">{error}</p> : null}
        {jobs.length === 0 ? (
          <p className="muted">No jobs yet. Sign in, then queue one. The invoices-worker will claim queued work.</p>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                #{job.id} {job.title} · {job.owner} · {job.status}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
