const LOG_LEVEL = process.env.CLWND_LOG_LEVEL ?? "info";
const TRACE = LOG_LEVEL === "trace" || LOG_LEVEL === "debug";

export function trace(event: string, data?: Record<string, unknown>): void {
  if (!TRACE) return;
  const parts = [event];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
  console.log(`[trace] ${parts.join(" ")}`);
}

export function info(event: string, data?: Record<string, unknown>): void {
  const parts = [event];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
  console.log(parts.join(" "));
}
