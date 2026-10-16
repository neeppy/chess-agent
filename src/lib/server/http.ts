import { json } from '@sveltejs/kit';
import type { Side } from '#lib/types.ts';
import { GameError } from './game';

export async function respond(fn: () => unknown | Promise<unknown>): Promise<Response> {
	try {
		return json(await fn());
	} catch (e) {
		if (e instanceof GameError) return json({ error: e.message }, { status: e.status });
		throw e;
	}
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? body : {};
	} catch {
		return {};
	}
}

/**
 * The base URL agents should use to reach the app: CHESS_PUBLIC_URL if set, otherwise derived
 * from the request (honouring a reverse proxy's X-Forwarded-* headers). Plain http by default.
 */
export function publicUrl(request: Request): string {
	if (process.env.CHESS_PUBLIC_URL) return process.env.CHESS_PUBLIC_URL.replace(/\/+$/, '');
	const h = request.headers;
	const first = (name: string) => h.get(name)?.split(',')[0].trim();
	return `${first('x-forwarded-proto') || 'http'}://${first('x-forwarded-host') || h.get('host') || 'localhost:5199'}`;
}

export function asSide(value: unknown): Side {
	if (value === 'human' || value === 'agent') return value;
	throw new GameError('"as" must be "human" or "agent".');
}
