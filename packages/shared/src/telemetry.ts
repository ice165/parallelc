export async function traceSpan(name: string, fn: () => Promise<void>): Promise<void> {
  if (process.env['PARALLELC_OTEL_ENABLED'] !== '1') return fn();
  const start = Date.now();
  console.log(`[OTel] SPAN_START ${name}`);
  try {
    await fn();
  } finally {
    console.log(`[OTel] SPAN_END ${name} duration=${Date.now() - start}ms`);
  }
}
