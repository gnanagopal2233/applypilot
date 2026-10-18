export default function Flash({ msg, error }: { msg?: string; error?: string }) {
  if (!msg && !error) return null;
  return (
    <div className={`flash ${error ? "flash-bad" : "flash-ok"}`}>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit" }}>{error || msg}</pre>
    </div>
  );
}
