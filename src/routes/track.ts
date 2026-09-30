/**
 * Tracking endpoints.
 *
 * Always answers 202, even when the event could not be stored. Reporting failure to
 * the browser buys us nothing: the customer cannot act on it, it would only cause the
 * snippet to retry and generate load during an incident, and the durability we actually
 * care about is handled by the id key plus the server-side retry queue.
 *
 * 202 Accepted is the honest status. We have taken responsibility for the event, and
 * the counters on /health tell us whether it really landed.
 */

import type { FastifyInstance } from 'fastify';
import type { TrackEvent } from '../core/types.js';
import type { Tracker } from '../services/tracker.js';
import { trackBodySchema, trackEventSchema } from './validation.js';

function toTrackEvent(
  e: {
    eventId: string;
    type: 'exposure' | 'conversion';
    namespace: string;
    experimentId: string;
    variantKey: string;
    visitorId: string;
    ts?: number;
    goal?: string | null;
    properties?: Record<string, unknown> | null;
  },
): TrackEvent {
  return {
    eventId: e.eventId,
    type: e.type,
    namespace: e.namespace,
    experimentId: e.experimentId,
    variantKey: e.variantKey,
    visitorId: e.visitorId,
    ts: e.ts ?? Date.now(),
    goal: e.goal ?? null,
    properties: e.properties ?? null,
  };
}

export function registerTrackRoutes(app: FastifyInstance, tracker: Tracker): void {
  app.post('/v1/track', async (req, reply) => {
    const body = req.body;

    // Single event, or a batch. Supporting both means the simplest client needs one
    // fetch and a high-traffic customer can amortise the request cost.
    const single = trackEventSchema.safeParse(body);
    let events: TrackEvent[];

    if (single.success) {
      events = [toTrackEvent(single.data)];
    } else {
      const batch = trackBodySchema.safeParse(body);
      if (!batch.success || Array.isArray(batch.data) || !('events' in batch.data)) {
        return reply.code(400).send({
          error: 'invalid_event',
          detail: single.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }
      events = batch.data.events.map(toTrackEvent);
    }

    const result = await tracker.ingestMany(events);

    return reply.code(202).send({
      accepted: result.durable ? events.length : 0,
      duplicates: result.duplicate ? events.length : 0,
      // Deliberately not surfaced as an error. The client did nothing wrong and there
      // is no useful action available to it.
      queued: result.durable ? 0 : events.length,
    });
  });

  /**
   * sendBeacon-compatible endpoint.
   *
   * sendBeacon cannot set headers and may send text/plain, so it gets a dedicated route
   * that skips content-type negotiation. Without this, the most reliable way for a
   * browser to deliver an event on page unload would be the one we reject.
   */
  app.post('/v1/beacon', async (req, reply) => {
    let payload: unknown = req.body;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return reply.code(400).send({ error: 'invalid_json' });
      }
    }
    const single = trackEventSchema.safeParse(payload);
    if (!single.success) {
      return reply.code(400).send({ error: 'invalid_event' });
    }
    const result = await tracker.ingest(toTrackEvent(single.data));
    return reply.code(202).send({ accepted: result.durable ? 1 : 0, duplicate: result.duplicate });
  });
}
