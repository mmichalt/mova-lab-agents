import os from 'node:os';
import {
  type Attributes,
  type Context,
  context,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import type { Config } from './config.ts';
import type { LlmUsage } from './content/schemas.ts';

export const TRACE_INSTRUMENTATION_SCOPE = 'mova-lab-agents';
export const DIAGNOSTIC_RETENTION_DAYS = 7;
export const WORKFLOW_CONTENT_RETENTION_DAYS = 30;
export const IDEMPOTENCY_TOMBSTONE_RETENTION_DAYS = 90;

export type TraceContextRecord = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};

export type RuntimeMetadata = {
  modelTag: string | null;
  modelDigest: string | null;
  quantization: string | null;
  ollamaVersion: string | null;
  contextTokens: number;
  outputTokens: number;
  hardware: {
    platform: string;
    arch: string;
    cpuModel: string | null;
    cpuCount: number;
    memoryBytes: number;
    gpu: null;
  };
  durationUnits: 'wall_ms';
  loadDurationUnits: 'nanoseconds';
};

export type UsageReport = {
  attempts: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: null;
  costStatus: 'unmeasured_local';
};

export type AttemptTimingReport = {
  attempts: number;
  wallDurationMs: number | null;
  loadDurationNs: number | null;
  promptEvaluationDurationNs: number | null;
  generationDurationNs: number | null;
  coldAttempts: number;
  warmAttempts: number;
};

export type ProviderTiming = {
  wallDurationMs: number | null;
  loadDurationNs: number | null;
  promptEvaluationDurationNs: number | null;
  generationDurationNs: number | null;
};

export type Observability = {
  tracer: Tracer;
  provider: NodeTracerProvider;
  diagnosticCapture: boolean;
  startSpan: (
    name: string,
    options?: SpanOptions & { links?: SpanOptions['links'] },
    parent?: Context,
  ) => Span;
  shutdown: () => Promise<void>;
};

let defaultObservability: Observability | undefined;

export function createObservability(
  options: {
    exporter?: SpanExporter;
    otlpEndpoint?: string | null;
    diagnosticCapture?: boolean;
    serviceName?: string;
  } = {},
): Observability {
  const exporter =
    options.exporter ??
    (options.otlpEndpoint
      ? new OTLPTraceExporter({ url: otlpTracesUrl(options.otlpEndpoint) })
      : undefined);
  const provider = new NodeTracerProvider({
    spanProcessors: exporter
      ? [options.exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)]
      : [],
  });
  provider.register();
  const tracer = provider.getTracer(TRACE_INSTRUMENTATION_SCOPE);
  const serviceName = options.serviceName ?? 'mova-lab-agents';
  return {
    tracer,
    provider,
    diagnosticCapture: options.diagnosticCapture === true,
    startSpan: (name, spanOptions, parent = context.active()) => {
      const span = tracer.startSpan(name, spanOptions, parent);
      span.setAttribute('service.name', serviceName);
      return span;
    },
    shutdown: () => provider.shutdown(),
  };
}

export function getObservability(config: Config): Observability {
  defaultObservability ??= createObservability({
    otlpEndpoint: config.otelExporterOtlpEndpoint,
    diagnosticCapture: config.diagnosticCapture,
    serviceName: config.otelServiceName,
  });
  return defaultObservability;
}

export async function withSpan<T>(
  observability: Observability | undefined,
  name: string,
  options: SpanOptions & { attributes?: Attributes } = {},
  work: (span: Span) => Promise<T> | T,
  parent = context.active(),
): Promise<T> {
  if (!observability) return work(trace.getTracer(TRACE_INSTRUMENTATION_SCOPE).startSpan(name));
  const span = observability.startSpan(name, options, parent);
  const childContext = trace.setSpan(parent, span);
  return context.with(childContext, async () => {
    try {
      const result = await work(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(safeException(err, observability?.diagnosticCapture === true));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function safeException(value: unknown, diagnostics = false) {
  if (!diagnostics) return 'operation failed';
  return JSON.stringify({
    name: value instanceof Error ? value.name : 'Error',
    message: '[REDACTED]',
  });
}

function otlpTracesUrl(endpoint: string) {
  const url = new URL(endpoint);
  if (url.pathname.endsWith('/v1/traces')) return url.toString();
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/traces`;
  return url.toString();
}

export function rootContext() {
  return ROOT_CONTEXT;
}

export function spanContextRecord(span: Span | SpanContext): TraceContextRecord {
  const contextValue = 'spanContext' in span ? span.spanContext() : span;
  return {
    traceId: contextValue.traceId,
    spanId: contextValue.spanId,
    traceFlags: contextValue.traceFlags,
  };
}

export function linksFor(records: readonly TraceContextRecord[] | undefined) {
  return (records ?? []).map((record) => ({
    context: {
      traceId: record.traceId,
      spanId: record.spanId,
      traceFlags: record.traceFlags,
      isRemote: true,
    },
  }));
}

export function aggregateUsage(usages: readonly LlmUsage[]): UsageReport {
  return {
    attempts: usages.length,
    inputTokens: completeSum(usages.map((usage) => usage.inputTokens)),
    cachedInputTokens: completeSum(usages.map((usage) => usage.cachedInputTokens)),
    outputTokens: completeSum(usages.map((usage) => usage.outputTokens)),
    estimatedCostUsd: null,
    costStatus: 'unmeasured_local',
  };
}

export function aggregateAttemptTiming(
  attempts: readonly {
    startedAt: number;
    finishedAt: number | null;
    usage: unknown;
  }[],
): AttemptTimingReport {
  const timings = attempts.map((attempt) => recordOf(attempt.usage));
  return {
    attempts: attempts.length,
    wallDurationMs: sumKnown(
      attempts.map((attempt) =>
        attempt.finishedAt === null ? null : Math.max(0, attempt.finishedAt - attempt.startedAt),
      ),
    ),
    loadDurationNs: sumField(timings, 'loadDurationNs'),
    promptEvaluationDurationNs: sumField(timings, 'promptEvaluationDurationNs'),
    generationDurationNs: sumField(timings, 'generationDurationNs'),
    coldAttempts: timings.filter(
      (timing) => typeof timing.loadDurationNs === 'number' && timing.loadDurationNs > 0,
    ).length,
    warmAttempts: timings.filter((timing) => timing.loadDurationNs === 0).length,
  };
}

export function aggregateProviderTiming(timings: readonly ProviderTiming[]): AttemptTimingReport {
  return {
    attempts: timings.length,
    wallDurationMs: sumKnown(timings.map((timing) => timing.wallDurationMs)),
    loadDurationNs: sumKnown(timings.map((timing) => timing.loadDurationNs)),
    promptEvaluationDurationNs: sumKnown(
      timings.map((timing) => timing.promptEvaluationDurationNs),
    ),
    generationDurationNs: sumKnown(timings.map((timing) => timing.generationDurationNs)),
    coldAttempts: timings.filter((timing) => (timing.loadDurationNs ?? 0) > 0).length,
    warmAttempts: timings.filter((timing) => timing.loadDurationNs === 0).length,
  };
}

export function initialRuntime(options: {
  modelTag: string | null;
  contextTokens: number;
  outputTokens: number;
}): RuntimeMetadata {
  const cpu = os.cpus()[0];
  return {
    modelTag: options.modelTag,
    modelDigest: null,
    quantization: null,
    ollamaVersion: null,
    contextTokens: options.contextTokens,
    outputTokens: options.outputTokens,
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpu?.model ?? null,
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      gpu: null,
    },
    durationUnits: 'wall_ms',
    loadDurationUnits: 'nanoseconds',
  };
}

export function diagnosticAttributes(
  observability: Observability | undefined,
  fields: Record<string, unknown>,
): Attributes {
  if (!observability?.diagnosticCapture) return {};
  return {
    'diagnostic.capture': 'redacted',
    'diagnostic.fields': JSON.stringify(redact(fields)),
  };
}

export function redact(value: unknown, key?: string): unknown {
  if (
    key &&
    /authorization|password|secret|token|prompt|response|content|message|body/i.test(key)
  ) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]),
    );
  }
  return value;
}

function completeSum(values: readonly (number | null)[]): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function sumKnown(values: readonly (number | null)[]) {
  return values.length === 0 || values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function sumField(values: readonly Record<string, unknown>[], field: string) {
  return sumKnown(values.map((value) => (typeof value[field] === 'number' ? value[field] : null)));
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
