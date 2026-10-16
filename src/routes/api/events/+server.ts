import { game } from '#lib/server/game.ts';
import type { RequestHandler } from './$types';

/**
 * Server-Sent Events: emits `state` (the full GameView) on connect and after every change.
 * Agents should connect with `?client=agent&name=<name>` so the UI can show that an agent is
 * connected.
 */
export const GET: RequestHandler = ({ url, request }) => {
	const isAgent = url.searchParams.get('client') === 'agent';
	const name = url.searchParams.get('name')?.slice(0, 40) || null;
	const encoder = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const sendState = () => write(`event: state\ndata: ${JSON.stringify(game.view())}\n\n`);

			const unsubscribe = game.subscribe(sendState);
			const disconnect = isAgent ? game.connectAgent(name) : () => {};
			const ping = setInterval(() => write(': ping\n\n'), 15_000);

			cleanup = () => {
				if (closed) return;
				closed = true;
				clearInterval(ping);
				unsubscribe();
				disconnect();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			request.signal.addEventListener('abort', cleanup);
			write('retry: 2000\n\n');
			sendState();
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
