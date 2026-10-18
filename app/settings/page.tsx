import { lastTask } from "../../src/core/tasks";
import { llmSettings, PROFILE_FILES, profileReady, readProfileFile, type ProfileFile } from "../../src/core/settings";
import type { Check } from "../../src/core/doctor";
import { createProfileAction, doctorAction, saveFileAction, saveModelAction } from "../actions";
import Flash from "../components/Flash";

export const dynamic = "force-dynamic";

export default async function Settings({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string; file?: string }> }) {
  const { msg, error, file } = await searchParams;
  const ready = profileReady();
  const llm = llmSettings();
  const doctor = lastTask("doctor");
  const checks = (doctor?.status === "done" ? (doctor.result as Check[]) : null) ?? null;
  const files = Object.keys(PROFILE_FILES) as ProfileFile[];
  const open = (file as ProfileFile) || files[0];

  return (
    <>
      <Flash msg={msg} error={error} />
      <h1 className="page-title">Settings</h1>

      {!ready ? (
        <div className="panel">
          <h2>step 1 · create your profile</h2>
          <p>Start from the examples, then edit each file below.</p>
          <form action={createProfileAction}>
            <button className="primary">Create my profile files</button>
          </form>
        </div>
      ) : null}

      <div className="grid2">
        <div className="panel">
          <h2>language model</h2>
          <form action={saveModelAction} className="form">
            <label>
              Provider
              <select name="provider" defaultValue={llm.provider}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama (local)</option>
              </select>
            </label>
            <label>
              Model <span className="muted small">(blank = default)</span>
              <input name="model" defaultValue={llm.model} placeholder="e.g. claude-sonnet-4-5" />
            </label>
            <label>
              API key <span className="muted small">{llm.keySet ? "✓ saved — leave blank to keep" : "not set"}</span>
              <input name="apiKey" type="password" autoComplete="off" placeholder={llm.keySet ? "••••••••" : "paste your key"} />
            </label>
            <label>
              Ollama URL <span className="muted small">(only for Ollama)</span>
              <input name="baseUrl" placeholder="http://localhost:11434/v1" />
            </label>
            <button className="primary">Save</button>
            <p className="muted small">Stored only in this computer&apos;s .env file.</p>
          </form>
        </div>

        <div className="panel">
          <h2>setup checks</h2>
          <form action={doctorAction}>
            <button className="primary">Run checks</button>
          </form>
          {doctor?.status === "running" ? <p className="muted">Running…</p> : null}
          {doctor?.status === "error" ? <p className="bad">{doctor.error}</p> : null}
          {checks ? (
            <ul className="checks">
              {checks.map((c) => (
                <li key={c.name} className={c.ok ? "ok" : "bad"}>
                  {c.ok ? "✔" : "✖"} <b>{c.name}</b> <span className="muted">— {c.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Checks your profile files, API key, browser, and every company board.</p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="tabs">
          {files.map((f) => (
            <a key={f} href={`/settings?file=${f}`} className={`tab ${f === open ? "active" : ""}`}>
              {PROFILE_FILES[f].title}
            </a>
          ))}
        </div>
        {(() => {
          const { content, exists } = readProfileFile(open);
          return (
            <form action={saveFileAction} className="form">
              <input type="hidden" name="file" value={open} />
              <p className="muted">
                {PROFILE_FILES[open].help} {exists ? "" : <b className="warn">(showing the example — save to create yours)</b>}
              </p>
              <textarea name="content" defaultValue={content} spellCheck={false} className="code" rows={28} />
              <button className="primary">Save {open}</button>
            </form>
          );
        })()}
      </div>
    </>
  );
}
